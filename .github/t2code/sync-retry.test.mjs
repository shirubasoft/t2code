import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { ensureRelease, plan, recordBlocked, validationTitle } from "./sync.mjs";

const assert = NodeAssert;
const { afterEach, test } = NodeTest;
const { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = NodeFS;
const { join } = NodePath;
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const originalDirectory = process.cwd();
const directories = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  process.chdir(originalDirectory);
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture({ pullRequest = true, legacy = false, current = false } = {}) {
  const directory = mkdtempSync(join(NodeOS.tmpdir(), "t2-sync-retry-"));
  directories.push(directory);
  const git = (...args) => {
    const result = NodeChildProcess.spawnSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
      { cwd: directory, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init");
  writeFileSync(join(directory, "source.ts"), "accepted\n");
  git("add", ".");
  git("commit", "-m", "accepted");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(directory, "source.ts"), "upstream\n");
  git("commit", "-am", "upstream");
  const upstream = current ? base : git("rev-parse", "HEAD");
  git("checkout", "--detach", base);
  git("remote", "add", "origin", directory);
  git("config", `url.${directory}/.insteadOf`, "https://github.com/pingdotgg/t3code.git");
  const repo = "shirubasoft/t2code";
  const head = "e".repeat(40);
  const pr = {
    number: 1,
    head: { sha: head, repo: { full_name: repo } },
    body: `<!-- t2-sync ${JSON.stringify({ base, upstream, attempt: 99 })} -->\n<!-- t2-sync-blocked -->`,
  };
  const issues = [
    {
      number: 8,
      body: legacy
        ? `Latest failure: https://github.com/${repo}/actions/runs/123\n<!-- t2-blocked ${base} ${upstream} -->`
        : `<!-- t2-sync-retry ${JSON.stringify({ base, upstream, run: 123 })} -->`,
    },
  ];
  const runs = [];
  const finishes = [];
  const releases = [{ draft: false, target_commitish: base }];
  const releaseRuns = [];
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, ...options });
    if (url.includes("/releases?")) return Response.json(releases);
    if (url.includes("/pulls?")) return Response.json(pullRequest ? [pr] : []);
    if (url.includes("/issues?")) return Response.json(issues);
    if (url.includes("/issues") && ["POST", "PATCH"].includes(options.method)) {
      const body = JSON.parse(options.body);
      if (options.method === "POST") issues.push({ number: 9, ...body });
      else
        Object.assign(
          issues.find((issue) => url.endsWith(`/issues/${issue.number}`)),
          body,
        );
      return Response.json(body);
    }
    if (url.includes("/dispatches")) return new Response(null, { status: 204 });
    if (url.includes("/merge-upstream.yml/")) return Response.json({ workflow_runs: finishes });
    if (url.includes("/release.yml/")) return Response.json({ workflow_runs: releaseRuns });
    if (url.includes("/actions/")) return Response.json({ workflow_runs: runs });
    return Response.json({ sha: url.includes("pingdotgg") ? upstream : base });
  };
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    '#!/usr/bin/env node\nconsole.log("Failed run " + process.argv[4] + ": preserved diagnostic");\n',
  );
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.GITHUB_REPOSITORY = repo;
  process.env.GITHUB_SHA = base;
  process.env.GITHUB_RUN_ID = "124";
  process.env.GITHUB_OUTPUT = join(directory, "output.txt");
  process.chdir(directory);
  return { base, upstream, head, pr, issues, runs, finishes, releases, releaseRuns, calls };
}

test("planning refuses a workflow loaded before main changed", async () => {
  const { calls } = fixture();
  process.env.GITHUB_SHA = "f".repeat(40);
  await plan();
  assert.match(readFileSync("output.txt", "utf8"), /ready=false\nreason=main-changed/);
  assert.equal(calls.length, 1);
});

test("a fully current fork recovers a missing accepted release without another migration", async () => {
  const { base, releases, calls } = fixture({ pullRequest: false, current: true });
  releases.length = 0;
  await plan();
  assert.match(readFileSync("output.txt", "utf8"), /ready=false\nreason=current/);
  const dispatches = calls.filter((call) => call.method === "POST");
  assert.equal(dispatches.length, 1);
  assert.ok(dispatches[0].url.endsWith("/release.yml/dispatches"));
  assert.deepEqual(JSON.parse(dispatches[0].body), { ref: "main", inputs: { sha: base } });
});

test("an already published accepted commit does not dispatch another release", async () => {
  const { base, calls } = fixture();
  assert.equal(await ensureRelease("shirubasoft/t2code", base), "published");
  assert.equal(calls.length, 1);
});

for (const status of ["queued", "in_progress", "completed"]) {
  test(`a ${status} release is recovered without duplicating active builds`, async () => {
    const { base, releases, releaseRuns, calls } = fixture();
    releases.length = 0;
    releaseRuns.push({
      head_sha: base,
      head_branch: "main",
      head_repository: { full_name: "shirubasoft/t2code" },
      path: ".github/workflows/release.yml",
      display_title: `T2 release ${base}`,
      event: "workflow_dispatch",
      status,
      conclusion: status === "completed" ? "failure" : null,
    });
    assert.equal(
      await ensureRelease("shirubasoft/t2code", base),
      status === "completed" ? "dispatched" : "running",
    );
    assert.equal(
      calls.filter((call) => call.method === "POST").length,
      status === "completed" ? 1 : 0,
    );
  });
}

test("a release request for a different input does not suppress accepted-main recovery", async () => {
  const { base, releases, releaseRuns, calls } = fixture();
  releases.length = 0;
  releaseRuns.push({
    head_sha: base,
    head_branch: "main",
    head_repository: { full_name: "shirubasoft/t2code" },
    path: ".github/workflows/release.yml",
    display_title: `T2 release ${"f".repeat(40)}`,
    event: "workflow_dispatch",
    status: "in_progress",
  });
  assert.equal(await ensureRelease("shirubasoft/t2code", base), "dispatched");
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
});

test("release recovery does not dispatch after accepted main changes", async () => {
  const { base, releases, calls } = fixture();
  releases.length = 0;
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, options) =>
    url.endsWith("/commits/main") ? Response.json({ sha: "f".repeat(40) }) : fetch(url, options);
  assert.equal(await ensureRelease("shirubasoft/t2code", base), "main-changed");
  assert.equal(
    calls.some((call) => call.method === "POST"),
    false,
  );
});

test("a release API outage does not stop upstream repair", async () => {
  fixture();
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, options) =>
    url.includes("/releases?")
      ? new Response("Release API unavailable", { status: 503 })
      : fetch(url, options);
  await plan();
  assert.match(readFileSync("output.txt", "utf8"), /ready=true/);
});

test("an old blocked input retries after many attempts and retains the candidate and proposal failure", async () => {
  const { head } = fixture({ legacy: true });
  await plan();
  const state = JSON.parse(readFileSync("sync-plan.json", "utf8"));
  assert.equal(state.start, head);
  assert.equal(state.attempt, 100);
  assert.equal(state.failedRun, 123);
  assert.match(
    readFileSync("validation-failure.txt", "utf8"),
    /Failed run 123: preserved diagnostic/,
  );
});

test("a proposal failure before any PR retries the same upstream input", async () => {
  const { base, upstream } = fixture({ pullRequest: false, legacy: true });
  await plan();
  const state = JSON.parse(readFileSync("sync-plan.json", "utf8"));
  assert.equal(state.start, base);
  assert.equal(state.upstream, upstream);
  assert.equal(state.failedRun, 123);
  assert.equal(state.pr, 0);
});

test("failed independent validation takes precedence over earlier proposal logs", async () => {
  const { base, head, runs } = fixture();
  runs.push({
    id: 456,
    display_title: validationTitle(1, head, base),
    status: "completed",
    conclusion: "failure",
  });
  await plan();
  const state = JSON.parse(readFileSync("sync-plan.json", "utf8"));
  assert.equal(state.start, head);
  assert.equal(state.failedRun, 456);
  assert.match(readFileSync("validation-failure.txt", "utf8"), /Failed run 456:/);
});

test("large failure logs remain available for incremental inspection", async () => {
  fixture();
  writeFileSync(
    "bin/gh",
    '#!/usr/bin/env node\nprocess.stdout.write("x".repeat(17 * 1024 * 1024) + "\\nFinal failure diagnostic\\n");\n',
  );
  await plan();
  const logs = readFileSync("validation-failure.txt", "utf8");
  assert.ok(logs.length > 17 * 1024 * 1024);
  assert.match(logs, /Final failure diagnostic\n$/);
});

test("unavailable historical logs do not prevent the next repair", async () => {
  fixture();
  writeFileSync(
    "bin/gh",
    '#!/usr/bin/env node\nconsole.error("Logs have expired"); process.exit(1);\n',
  );
  await plan();
  assert.match(readFileSync("output.txt", "utf8"), /ready=true/);
  assert.match(readFileSync("validation-failure.txt", "utf8"), /Logs have expired/);
  assert.match(
    readFileSync("validation-failure.txt", "utf8"),
    /Continue by inspecting the candidate/,
  );
});

for (const [status, conclusion, reason] of [
  ["in_progress", null, "validation-running"],
  ["completed", "success", "awaiting-merge"],
]) {
  test(`automatic retries wait while ${reason}`, async () => {
    const { base, head, runs, calls } = fixture();
    runs.push({
      id: 456,
      display_title: validationTitle(1, head, base),
      status,
      conclusion,
      updated_at: new Date().toISOString(),
    });
    await plan();
    assert.match(readFileSync("output.txt", "utf8"), new RegExp(`ready=false\nreason=${reason}`));
    assert.equal(
      calls.some((call) => ["POST", "PUT", "PATCH"].includes(call.method)),
      false,
    );
  });
}

for (const status of ["failure", "missing"]) {
  test(`successful validation with a ${status} finalizer retries only the trusted merge`, async () => {
    const { base, head, runs, finishes, calls } = fixture();
    runs.push({
      id: 456,
      display_title: validationTitle(1, head, base),
      status: "completed",
      conclusion: "success",
      updated_at: "2020-01-01T00:00:00Z",
    });
    if (status === "failure")
      finishes.push({
        display_title: "T2 merge validation @456",
        status: "completed",
        conclusion: "failure",
      });
    await plan();
    assert.match(readFileSync("output.txt", "utf8"), /reason=merge-retry-dispatched/);
    const dispatches = calls.filter((call) => call.method === "POST");
    assert.equal(dispatches.length, 1);
    assert.ok(dispatches[0].url.endsWith("/merge-upstream.yml/dispatches"));
    assert.deepEqual(JSON.parse(dispatches[0].body), {
      ref: "main",
      inputs: { validation_run_id: "456" },
    });
  });
}

test("an active finalizer finishes before another retry is dispatched", async () => {
  const { base, head, runs, finishes, calls } = fixture();
  runs.push({
    id: 456,
    display_title: validationTitle(1, head, base),
    status: "completed",
    conclusion: "success",
    updated_at: "2020-01-01T00:00:00Z",
  });
  finishes.push({ display_title: "T2 merge validation @456", status: "in_progress" });
  await plan();
  assert.match(readFileSync("output.txt", "utf8"), /reason=awaiting-merge/);
  assert.equal(
    calls.some((call) => call.method === "POST"),
    false,
  );
});

test("one failure tracker is updated across attempts and upstream inputs", async () => {
  const { base, upstream, issues, calls } = fixture({ legacy: true });
  await recordBlocked({ base, upstream });
  process.env.GITHUB_RUN_ID = "125";
  await recordBlocked({ base, upstream: "f".repeat(40) });
  assert.equal(issues.length, 1);
  assert.match(issues[0].body, /actions\/runs\/125/);
  assert.match(issues[0].body, /retry automatically/);
  assert.match(issues[0].body, /"run":125/);
  assert.equal(
    calls.some((call) => call.method === "POST"),
    false,
  );
});

test("a first failure creates a tracking issue without requiring a manual reset", async () => {
  const { base, upstream, issues } = fixture();
  issues.length = 0;
  await recordBlocked({ base, upstream });
  await recordBlocked({ base, upstream });
  assert.equal(issues.length, 1);
  assert.match(issues[0].body, /next hourly run will retry automatically/);
  assert.doesNotMatch(issues[0].body, /Close this issue/);
});
