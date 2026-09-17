import * as NodeAssert from "node:assert/strict";
const assert = NodeAssert;
import * as NodeChildProcess from "node:child_process";
const { spawnSync } = NodeChildProcess;
import * as NodeFS from "node:fs";
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } =
  NodeFS;
import * as NodeOS from "node:os";
const { tmpdir } = NodeOS;
import * as NodePath from "node:path";
const { join } = NodePath;
import * as NodeTest from "node:test";
const { afterEach, test } = NodeTest;
import {
  applyEdits,
  assertEditable,
  finishValidation,
  plan,
  prepareMerge,
  validationTitle,
} from "./sync.mjs";
import { unexpectedConnections } from "./verify-network-trace.mjs";

const directories = [];
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function repository() {
  const directory = mkdtempSync(join(tmpdir(), "t2-sync-test-"));
  directories.push(directory);
  const result = spawnSync("git", ["init", directory], { encoding: "utf8" });
  assert.equal(result.status, 0);
  return directory;
}

function git(directory, args) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      ...args,
    ],
    { cwd: directory, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trimEnd();
}

function mergeFixture(baseFiles, upstreamFiles) {
  const root = repository();
  const directory = join(root, "candidate");
  mkdirSync(directory);
  git(root, ["init", directory]);
  const put = (files) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(NodePath.dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), content);
    }
  };
  put(baseFiles);
  git(directory, ["add", "--all"]);
  git(directory, ["commit", "-m", "accepted base"]);
  const base = git(directory, ["rev-parse", "HEAD"]);
  put(upstreamFiles);
  git(directory, ["add", "--all"]);
  git(directory, ["commit", "-m", "upstream"]);
  const upstream = git(directory, ["rev-parse", "HEAD"]);
  git(directory, ["checkout", "--detach", base]);
  git(directory, ["remote", "add", "origin", directory]);
  // Redirect the controller's fixed upstream URL to this isolated repository.
  git(directory, [
    "config",
    `url.${directory}/.insteadOf`,
    "https://github.com/pingdotgg/t3code.git",
  ]);
  return { directory, state: { base, upstream, start: base, attempt: 1 } };
}

test("merge cleanup removes literal metacharacter filenames without removing accepted workflows", () => {
  const accepted = {
    ".github/workflows/ci.yml": "accepted CI\n",
    ".github/workflows/release.yml": "accepted release\n",
  };
  const added = {
    ".github/workflows/ci[.]yml": "untrusted CI\n",
    ".github/workflows/release[.]yml": "untrusted release\n",
  };
  const { directory, state } = mergeFixture(accepted, added);
  prepareMerge(state, directory);
  for (const [path, content] of Object.entries(accepted)) {
    assert.equal(readFileSync(join(directory, path), "utf8"), content);
    assert.equal(git(directory, ["show", `:${path}`]), content.trimEnd());
  }
  for (const path of Object.keys(added)) assert.equal(existsSync(join(directory, path)), false);
  assert.equal(git(directory, ["diff", "--cached", "--name-only", state.base]), "");
});

test("merge cleanup restores accepted protected filenames literally", () => {
  const path = ".github/workflows/ci[.]yml";
  const { directory, state } = mergeFixture(
    { [path]: "accepted literal\n", ".github/workflows/ci.yml": "accepted CI\n" },
    { [path]: "untrusted replacement\n" },
  );
  prepareMerge(state, directory);
  assert.equal(readFileSync(join(directory, path), "utf8"), "accepted literal\n");
  assert.equal(git(directory, ["diff", "--cached", "--name-only", state.base]), "");
});

test("merge cleanup preserves privacy boundaries outside the workflow path list", () => {
  const accepted = {
    "apps/desktop/scripts/verify-preload-bundle.mjs": "accepted preload guard\n",
    "apps/server/src/cli/update.ts": "user-initiated fork updates\n",
    "apps/server/src/cloud/pinnedRuntime.ts": "local runtime\n",
  };
  const { directory, state } = mergeFixture(accepted, {
    "apps/desktop/scripts/verify-preload-bundle.mjs": "upstream guard\n",
    "apps/server/src/cli/update.ts": "upstream updates\n",
    "apps/server/src/cloud/pinnedRuntime.ts": "hosted runtime\n",
    "apps/server/src/unprotected.ts": "upstream feature\n",
  });
  prepareMerge(state, directory);
  for (const [path, content] of Object.entries(accepted)) {
    assert.equal(readFileSync(join(directory, path), "utf8"), content);
    assert.equal(git(directory, ["show", `:${path}`]), content.trimEnd());
    assert.throws(() => assertEditable(path));
  }
  assert.equal(
    git(directory, ["diff", "--cached", "--name-only", state.base]),
    "apps/server/src/unprotected.ts",
  );
});

test("all accepted privacy boundaries are protected from agent edits", () => {
  const privacy = JSON.parse(
    readFileSync(new URL("../../scripts/private-build-policy.json", import.meta.url), "utf8"),
  );
  for (const path of Object.keys(privacy.boundaries)) {
    assert.throws(() => assertEditable(path), path);
  }
});

test("agent edits stage only the literal filename containing metacharacters", () => {
  const directory = repository();
  writeFileSync(join(directory, "source.ts"), "accepted\n");
  git(directory, ["add", "--all"]);
  git(directory, ["commit", "-m", "accepted base"]);
  writeFileSync(join(directory, "source.ts"), "unrelated unstaged change\n");
  applyEdits(
    { decision: "ready", edits: [{ path: "source[.]ts", content: "requested edit\n" }] },
    directory,
  );
  assert.equal(git(directory, ["diff", "--cached", "--name-only"]), "source[.]ts");
  assert.equal(git(directory, ["show", ":source.ts"]), "accepted");
  assert.equal(git(directory, ["show", ":source[.]ts"]), "requested edit");
});

test("agent edits cannot modify trust controls or escape the checkout", () => {
  for (const path of [
    "../outside",
    "/absolute",
    ".git/config",
    ".GIT/hooks/pre-commit",
    ".gitmodules",
    ".github/workflows/ci.yml",
    "scripts/verify-private-build.mjs",
    "apps/../../outside",
    "apps\\outside",
    "bad\npath",
  ]) {
    assert.throws(() => assertEditable(path));
  }
  assert.doesNotThrow(() => assertEditable("apps/server/src/example.ts"));
});

test("all edits are checked before any file is written", () => {
  const directory = repository();
  writeFileSync(join(directory, "source.ts"), "old\n");
  assert.throws(() =>
    applyEdits(
      {
        decision: "ready",
        edits: [
          { path: "source.ts", content: "new\n" },
          { path: "../escape", content: "bad" },
        ],
      },
      directory,
    ),
  );
  assert.equal(readFileSync(join(directory, "source.ts"), "utf8"), "old\n");
});

test("edits reject both existing and dangling symlinks", () => {
  const directory = repository();
  for (const [name, destination] of [
    ["existing", tmpdir()],
    ["dangling", join(directory, "absent")],
  ]) {
    symlinkSync(destination, join(directory, name));
    assert.throws(
      () =>
        applyEdits(
          { decision: "ready", edits: [{ path: `${name}/file`, content: "bad" }] },
          directory,
        ),
      /symlink/,
    );
  }
});

test("ready edits stage real file replacements and blocked decisions leave files alone", () => {
  const directory = repository();
  writeFileSync(join(directory, "source.ts"), "old\n");
  assert.throws(
    () =>
      applyEdits(
        {
          decision: "blocked",
          summary: "policy conflict",
          edits: [{ path: "source.ts", content: "bad" }],
        },
        directory,
      ),
    /blocked/,
  );
  applyEdits({ decision: "ready", edits: [{ path: "source.ts", content: "new\n" }] }, directory);
  assert.equal(
    spawnSync("git", ["show", ":source.ts"], { cwd: directory, encoding: "utf8" }).stdout,
    "new\n",
  );
});

test("a migration can repair more than 100 small files without changing its payload bound", () => {
  const directory = repository();
  const edits = Array.from({ length: 101 }, (_, index) => ({
    path: `source-${index}.ts`,
    content: "fixed\n",
  }));
  applyEdits({ decision: "ready", edits }, directory);
  assert.equal(git(directory, ["diff", "--cached", "--name-only"]).split("\n").length, 101);
  assert.throws(
    () =>
      applyEdits(
        {
          decision: "ready",
          edits: [{ path: "oversized.ts", content: "x".repeat(5 * 1024 * 1024) }],
        },
        directory,
      ),
    /edit limit/,
  );
  assert.equal(existsSync(join(directory, "oversized.ts")), false);
});

function validationFixture(overrides = {}) {
  const directory = repository();
  const base = "a".repeat(40);
  const sha = "b".repeat(40);
  const upstream = "c".repeat(40);
  const repo = "shirubasoft/t2code";
  const run = {
    id: 7,
    event: "workflow_dispatch",
    conclusion: "success",
    head_branch: "main",
    head_sha: base,
    head_repository: { full_name: repo },
    path: ".github/workflows/ci.yml",
    display_title: validationTitle(1, sha, base),
    html_url: "https://github.com/test/actions/runs/7",
    ...overrides,
  };
  process.env.GITHUB_REPOSITORY = repo;
  process.env.GITHUB_EVENT_PATH = join(directory, "event.json");
  writeFileSync(process.env.GITHUB_EVENT_PATH, JSON.stringify({ workflow_run: run }));
  const pr = {
    number: 1,
    state: "open",
    draft: false,
    head: { sha, ref: "codex/upstream-sync", repo: { full_name: repo } },
    base: { sha: base, ref: "main" },
    body: `<!-- t2-sync ${JSON.stringify({ base, upstream, attempt: 1 })} -->`,
  };
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, ...options });
    let data;
    if (url.endsWith("/jobs?per_page=100"))
      data = {
        jobs: [
          "Trusted privacy",
          "Check",
          "Test",
          "Test Server 1",
          "Test Server 2",
          "Test Server 3",
          "Rust",
          "Release Smoke",
          "CI result",
        ].map((name) => ({ name, conclusion: "success" })),
      };
    else if (url.includes("/issues?")) data = [];
    else if (url.endsWith("/actions/runs/7")) data = run;
    else if (url.endsWith("/pulls/1")) data = pr;
    else if (url.endsWith("/commits/main")) data = { sha: base };
    else if (url.endsWith("/merge")) data = { merged: true, sha: "d".repeat(40) };
    else if (url.endsWith("/dispatches")) return new Response(null, { status: 204 });
    else data = {};
    return Response.json(data);
  };
  return { pr, calls, base, sha, run };
}

test("trusted merger rejects candidate-defined workflow runs before making API calls", async () => {
  const { calls } = validationFixture({ head_branch: "codex/upstream-sync" });
  await assert.rejects(finishValidation(), /accepted trusted/);
  assert.equal(calls.length, 0);
});

test("trusted merger rejects a changed head before writing status or merging", async () => {
  const { pr, calls } = validationFixture();
  pr.head.sha = "e".repeat(40);
  await assert.rejects(finishValidation(), /changed after validation/);
  assert.equal(
    calls.some((call) => call.method === "PUT" || call.method === "POST"),
    false,
  );
});

test("a dispatched merge retry reloads the original trusted validation", async () => {
  const { calls, sha } = validationFixture();
  writeFileSync(
    process.env.GITHUB_EVENT_PATH,
    JSON.stringify({ inputs: { validation_run_id: "7" } }),
  );
  await finishValidation();
  assert.ok(calls[0].url.endsWith("/actions/runs/7"));
  const merge = calls.find((call) => call.url.endsWith("/merge"));
  assert.equal(JSON.parse(merge.body).sha, sha);
});

test("a dispatched merge retry rejects candidate-defined runs", async () => {
  const { calls } = validationFixture({ head_branch: "codex/upstream-sync" });
  writeFileSync(
    process.env.GITHUB_EVENT_PATH,
    JSON.stringify({ inputs: { validation_run_id: "7" } }),
  );
  await assert.rejects(finishValidation(), /accepted trusted/);
  assert.equal(calls.length, 1);
});

test("a dispatched merge retry rejects a stale validated head", async () => {
  const { calls, pr } = validationFixture();
  pr.head.sha = "e".repeat(40);
  writeFileSync(
    process.env.GITHUB_EVENT_PATH,
    JSON.stringify({ inputs: { validation_run_id: "7" } }),
  );
  await assert.rejects(finishValidation(), /changed after validation/);
  assert.equal(
    calls.some((call) => ["POST", "PUT", "PATCH"].includes(call.method)),
    false,
  );
});

test("trusted merger pins the head SHA, preserves ancestry, and releases the returned merge SHA", async () => {
  const { calls, sha } = validationFixture();
  await finishValidation();
  const merge = calls.find((call) => call.url.endsWith("/merge"));
  assert.deepEqual(JSON.parse(merge.body), { sha, merge_method: "merge" });
  const release = calls.find((call) => call.url.endsWith("release.yml/dispatches"));
  assert.equal(JSON.parse(release.body).inputs.sha, "d".repeat(40));
});

test("a successful merge closes its retry report after dispatching the release", async () => {
  const { calls, base } = validationFixture();
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, options) =>
    url.includes("/issues?")
      ? Response.json([
          {
            number: 9,
            body: `<!-- t2-sync-retry ${JSON.stringify({ base, upstream: "c".repeat(40), run: 3 })} -->`,
          },
        ])
      : fetch(url, options);
  await finishValidation();
  const close = calls.findIndex((call) => call.url.endsWith("/issues/9"));
  const release = calls.findIndex((call) => call.url.endsWith("release.yml/dispatches"));
  assert.ok(close > release);
  assert.deepEqual(JSON.parse(calls[close].body), { state: "closed", state_reason: "completed" });
});

test("network smoke rejects attempted public requests and local DNS while permitting its loopback client", () => {
  const loopback =
    '42 connect(7, {sa_family=AF_INET, sin_port=htons(47700), sin_addr=inet_addr("127.0.0.1")}, 16) = 0';
  const publicRequest =
    '43 connect(7, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("1.1.1.1")}, 16) = -1 ENETUNREACH';
  const dns =
    '43 sendto(7, "dns", 3, 0, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("127.0.0.53")}, 16) = -1';
  assert.deepEqual(unexpectedConnections(loopback), []);
  assert.deepEqual(unexpectedConnections([loopback, publicRequest, dns].join("\n")), [
    publicRequest,
    dns,
  ]);
});

test("a changed upstream input resumes a formerly blocked PR and keeps its repairs", async () => {
  const directory = repository();
  const previousDirectory = process.cwd();
  const base = "a".repeat(40);
  const upstream = "b".repeat(40);
  const head = "c".repeat(40);
  process.env.GITHUB_REPOSITORY = "shirubasoft/t2code";
  delete process.env.GITHUB_OUTPUT;
  globalThis.fetch = async (url) => {
    if (url.includes("/releases?"))
      return Response.json([{ draft: false, target_commitish: base }]);
    if (url.includes("/pulls?"))
      return Response.json([
        {
          number: 1,
          head: { sha: head, repo: { full_name: "shirubasoft/t2code" } },
          body: `<!-- t2-sync ${JSON.stringify({ base, upstream: "d".repeat(40), attempt: 3 })} -->\n<!-- t2-sync-blocked -->`,
        },
      ]);
    if (url.includes("/issues?")) return Response.json([]);
    if (url.includes("/actions/")) return Response.json({ workflow_runs: [] });
    return Response.json({ sha: url.includes("pingdotgg") ? upstream : base });
  };
  try {
    process.chdir(directory);
    await plan();
    const state = JSON.parse(readFileSync("sync-plan.json", "utf8"));
    assert.equal(state.attempt, 1);
    assert.equal(state.start, head);
    assert.equal(state.upstream, upstream);
  } finally {
    process.chdir(previousDirectory);
  }
});
