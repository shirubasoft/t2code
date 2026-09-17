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
const path = args[1];
if (path.endsWith("git/ref/heads/main")) console.log(JSON.stringify({object:{sha:state.base}}));
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
