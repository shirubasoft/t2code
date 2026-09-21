import * as NodeAssert from "node:assert/strict";
const assert = NodeAssert;
import * as NodeChildProcess from "node:child_process";
const { spawnSync } = NodeChildProcess;
import * as NodeFS from "node:fs";
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = NodeFS;
import * as NodeOS from "node:os";
const { tmpdir } = NodeOS;
import * as NodePath from "node:path";
const { join, delimiter } = NodePath;
import * as NodeTest from "node:test";
const { test } = NodeTest;
import { controlRoot } from "./overlay.mjs";

test("planning rejects an advanced main even when its commit diff exceeds the process buffer", () => {
  const root = mkdtempSync(join(tmpdir(), "t2-sync-main-"));
  const output = join(root, "output");
  try {
    writeFileSync(
      join(root, "gh"),
      `#!${process.execPath}
const sha = "f".repeat(40);
const endpoint = process.argv[3];
if (endpoint === "repos/shirubasoft/t2code/git/ref/heads/main") {
  process.stdout.write(JSON.stringify({ object: { type: "commit", sha } }));
} else if (endpoint === "repos/shirubasoft/t2code/commits/main") {
  process.stdout.write(JSON.stringify({ sha, files: [{ patch: "x".repeat(2 * 1024 * 1024) }] }));
} else {
  throw new Error("Unexpected API endpoint: " + endpoint);
}
`,
      { mode: 0o755 },
    );
    const result = spawnSync(
      process.execPath,
      [join(controlRoot, ".github/t2code/sync.mjs"), "plan"],
      {
        cwd: controlRoot,
        env: {
          ...process.env,
          PATH: `${root}${delimiter}${process.env.PATH}`,
          GITHUB_OUTPUT: output,
        },
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    assert.equal(result.status, 0, result.stderr.slice(0, 1000));
    assert.equal(readFileSync(output, "utf8"), "ready=false\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function nightlyFixture() {
  const root = mkdtempSync(join(tmpdir(), "t2-sync-nightly-"));
  const upstream = join(root, "upstream");
  const checkout = join(root, "checkout");
  const commands = join(root, "commands");
  const actualGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  for (const path of [upstream, checkout, commands]) NodeFS.mkdirSync(path);
  const git = (cwd, ...args) => {
    const result = spawnSync(actualGit, args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const commit = (cwd, message) => {
    git(cwd, "add", "--all");
    git(
      cwd,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      message,
    );
    return git(cwd, "rev-parse", "HEAD");
  };
  git(upstream, "init");
  writeFileSync(join(upstream, "app.txt"), "nightly source\n");
  NodeFS.mkdirSync(join(upstream, ".github/workflows"), { recursive: true });
  writeFileSync(join(upstream, ".github/workflows/release.yml"), "upstream release\n");
  writeFileSync(join(upstream, ".github/workflows/deploy.yml"), "upstream deployment\n");
  const nightlySha = commit(upstream, "Published nightly");
  const tag = "v0.0.43-nightly.20260917.1866";
  git(
    upstream,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "tag",
    "-a",
    tag,
    "-m",
    "Nightly",
    "--",
    nightlySha,
  );
  writeFileSync(join(upstream, "app.txt"), "unreleased main change\n");
  const mainSha = commit(upstream, "Unreleased main");
  git(checkout, "clone", upstream, ".");
  writeFileSync(join(checkout, ".github/workflows/release.yml"), "fork release\n");
  rmSync(join(checkout, ".github/workflows/deploy.yml"));
  writeFileSync(join(checkout, ".github/CODEOWNERS"), "* @fork-maintainer\n");
  NodeFS.mkdirSync(join(checkout, ".github/t2code"), { recursive: true });
  writeFileSync(
    join(checkout, ".github/t2code/upstream.json"),
    JSON.stringify({ repository: "pingdotgg/t3code", commit: mainSha }),
  );
  writeFileSync(
    join(checkout, ".github/t2code/overlay.json"),
    JSON.stringify({ files: [], replacements: [] }),
  );
  const base = commit(checkout, "Fork controls");
  const release = {
    id: 42,
    tag_name: tag,
    draft: false,
    prerelease: true,
    published_at: "2026-09-17T15:43:08Z",
    target_commitish: "main",
  };
  const stateFile = join(root, "state.json");
  const state = { base, release, runs: [], fork: null };
  const record = join(root, "calls.jsonl");
  writeFileSync(
    join(commands, "gh"),
    `#!${process.execPath}
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}));
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(args) + "\\n");
if (args[0] === "workflow") process.exit(0);
if (args[0] === "run" && args[1] === "download") {
  fs.writeFileSync(require("node:path").join(args[args.indexOf("--dir") + 1], "feedback.json"), JSON.stringify(state.feedback));
  process.exit(0);
}
const path = args[1];
if (path.endsWith("git/ref/heads/main")) console.log(JSON.stringify({object:{sha:state.base}}));
else if (path.includes("/actions/artifacts?name=sync-feedback-")) console.log(JSON.stringify({artifacts:state.feedback ? [{id:1,expired:false,workflow_run:{id:17,head_branch:"main",head_sha:state.base}}] : []}));
else if (path.endsWith("/actions/runs/17")) console.log(JSON.stringify({id:17,path:".github/workflows/upstream-sync.yml",event:"schedule",status:"completed"}));
else if (path.includes("pingdotgg/t3code/releases/tags/")) console.log(JSON.stringify(state.release));
else if (path.includes("pingdotgg/t3code/releases?")) console.log(JSON.stringify([state.release]));
else if (path.includes("shirubasoft/t2code/releases/tags/")) {
  if (state.fork) console.log(JSON.stringify(state.fork));
  else { console.error("gh: Not Found (HTTP 404)"); process.exit(1); }
} else if (path.includes("release.yml/runs")) console.log(JSON.stringify({workflow_runs:state.runs}));
else throw new Error("Unexpected endpoint: " + path);
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(commands, "git"),
    `#!${process.execPath}
const args = process.argv.slice(2).map(arg => arg === "https://github.com/pingdotgg/t3code.git" ? ${JSON.stringify(upstream)} : arg);
const result = require("node:child_process").spawnSync(${JSON.stringify(actualGit)}, args, {stdio:"inherit"});
process.exit(result.status ?? 1);
`,
    { mode: 0o755 },
  );
  const output = join(root, "output");
  return {
    root,
    checkout,
    tag,
    nightlySha,
    mainSha,
    state,
    commit,
    run: (command = "plan") => {
      writeFileSync(stateFile, JSON.stringify(state));
      writeFileSync(output, "");
      const result = spawnSync(
        process.execPath,
        [join(controlRoot, ".github/t2code/sync.mjs"), command],
        {
          cwd: checkout,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${commands}${delimiter}${process.env.PATH}`,
            GITHUB_OUTPUT: output,
            T2_NIGHTLY_TAG: tag,
            T2_RELEASE_SHA: state.base,
          },
        },
      );
      return {
        ...result,
        output: readFileSync(output, "utf8"),
        calls: readFileSync(record, "utf8"),
      };
    },
  };
}

test("planning resolves an annotated nightly tag, not the release's main target or newer main", () => {
  const f = nightlyFixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(readFileSync(join(f.checkout, "review/plan.json")));
    assert.equal(plan.from, f.mainSha);
    assert.equal(plan.upstream, f.nightlySha);
    assert.equal(plan.nightly.tag, f.tag);
    assert.match(
      readFileSync(join(f.checkout, "review/upstream.diff"), "utf8"),
      /-unreleased main change/,
    );
    assert.match(result.output, /ready=true/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("review receives the accepted controls that replace upstream workflows", () => {
  const f = nightlyFixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const controls = join(f.checkout, "review/fork-controls");
    assert.equal(
      readFileSync(join(controls, ".github/workflows/release.yml"), "utf8"),
      "fork release\n",
    );
    assert.equal(NodeFS.existsSync(join(controls, ".github/workflows/deploy.yml")), false);
    assert.equal(
      readFileSync(join(controls, ".github/CODEOWNERS"), "utf8"),
      "* @fork-maintainer\n",
    );
    assert.deepEqual(JSON.parse(readFileSync(join(controls, ".github/t2code/overlay.json"))), {
      files: [],
      replacements: [],
    });
    assert.equal(
      JSON.parse(readFileSync(join(controls, ".github/t2code/upstream.json"))).commit,
      f.mainSha,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("an accepted nightly awaiting publication retries its original source after control-only commits", () => {
  const f = nightlyFixture();
  try {
    writeFileSync(
      join(f.checkout, ".github/t2code/upstream.json"),
      JSON.stringify({
        repository: "pingdotgg/t3code",
        commit: f.nightlySha,
        tag: f.tag,
        releaseId: 42,
      }),
    );
    const accepted = f.commit(f.checkout, "Accept nightly");
    f.state.base = f.commit(f.checkout, "Control-only change");
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, `ready=false\nrelease_sha=${accepted}\ntag=${f.tag}\n`);
    assert.equal(NodeFS.existsSync(join(f.checkout, "review")), false);
    f.state.runs = [{ display_title: `T2 nightly ${f.tag}`, status: "in_progress" }];
    assert.doesNotMatch(f.run("retry-release").calls, /\["workflow"/);
    f.state.runs = [
      { display_title: `T2 nightly ${f.tag}`, status: "completed", conclusion: "failure" },
    ];
    assert.match(f.run("retry-release").calls, /\["workflow","run","release.yml"/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("planning rejects an accepted nightly whose tag was moved", () => {
  const f = nightlyFixture();
  try {
    writeFileSync(
      join(f.checkout, ".github/t2code/upstream.json"),
      JSON.stringify({
        repository: "pingdotgg/t3code",
        commit: f.mainSha,
        tag: f.tag,
        releaseId: 42,
      }),
    );
    f.state.base = f.commit(f.checkout, "Wrong nightly pin");
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Pinned upstream nightly identity changed/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("scheduled planning resumes prior repairs, defers exhausted cycles and retains feedback after cooldown", () => {
  const f = nightlyFixture();
  try {
    f.state.feedback = {
      version: 1,
      base: f.state.base,
      upstream: f.nightlySha,
      runId: 17,
      attempt: 1,
      finishedAt: new Date().toISOString(),
      agentOutput: JSON.stringify({ decision: "blocked", summary: "stale patch", edits: [] }),
      failures: [{ name: "propose", log: "Patch anchor must occur once" }],
    };
    const resumed = f.run();
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.output, /ready=true/);
    assert.equal(JSON.parse(readFileSync(join(f.checkout, "review/plan.json"))).attempt, 2);
    assert.deepEqual(
      JSON.parse(readFileSync(join(f.checkout, "review/feedback.json"))),
      f.state.feedback,
    );
    f.state.feedback.attempt = 3;
    const deferred = f.run();
    assert.equal(deferred.status, 0, deferred.stderr);
    assert.equal(deferred.output, "ready=false\n");
    assert.match(deferred.stdout, /Sync repair deferred until/);
    f.state.feedback.finishedAt = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const nextCycle = f.run();
    assert.equal(nextCycle.status, 0, nextCycle.stderr);
    assert.match(nextCycle.output, /ready=true/);
    assert.equal(JSON.parse(readFileSync(join(f.checkout, "review/plan.json"))).attempt, 1);
    assert.equal(
      JSON.parse(readFileSync(join(f.checkout, "review/feedback.json"))).failures[0].log,
      "Patch anchor must occur once",
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
