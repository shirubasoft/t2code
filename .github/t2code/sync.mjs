import * as NodeFS from "node:fs";
const { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } = NodeFS;
import * as NodePath from "node:path";
const { resolve } = NodePath;
import * as NodeChildProcess from "node:child_process";
const { execFileSync } = NodeChildProcess;
import { apply, verify, git, readJson, assertSha, controlRoot } from "./overlay.mjs";

import {
  forkRepository,
  nextNightly,
  resolveNightly,
  verifyNightly,
  forkRelease,
  releaseInProgress,
  nightlyVersion,
} from "./nightly.mjs";

const repository = forkRepository;
const branch = "codex/analytics-sync";
function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
}
function api(path, data, method = data ? "POST" : "GET") {
  return JSON.parse(
    execFileSync(
      "gh",
      ["api", `repos/${repository}/${path}`, "--method", method, ...(data ? ["--input", "-"] : [])],
      { input: data ? JSON.stringify(data) : undefined, encoding: "utf8" },
    ),
  );
}
function output(values) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}
function dispatchRelease(sha, tag) {
  gh([
    "workflow",
    "run",
    "release.yml",
    "--repo",
    repository,
    "--ref",
    "main",
    "-f",
    `sha=${assertSha(sha)}`,
    "-f",
    `tag=${tag}`,
  ]);
}
function plan() {
  const base = assertSha(git(["rev-parse", "HEAD"]).trim());
  if (api("git/ref/heads/main").object.sha !== base) {
    output({ ready: false });
    return;
  }
  const pin = readJson(".github/t2code/upstream.json");
  const from = assertSha(pin.commit);
  if (pin.tag) {
    verifyNightly(pin);
    const released = forkRelease(pin.tag);
    if (!released || released.draft) {
      const releaseSha = assertSha(
        git([
          "log",
          "-1",
          "--first-parent",
          "--format=%H",
          base,
          "--",
          ".github/t2code/upstream.json",
        ]).trim(),
      );
      output({ ready: false, release_sha: releaseSha, tag: pin.tag });
      return;
    }
  }
  const release = nextNightly(pin);
  if (!release) {
    output({ ready: false });
    return;
  }
  const nightly = resolveNightly(release);
  const upstream = nightly.commit;
  // Initial migration may return from an unreleased main snapshot to its last
  // nightly. Subsequent nightlies must retain the accepted source ancestry.
  if (pin.tag) git(["merge-base", "--is-ancestor", from, upstream]);
  mkdirSync("review", { recursive: true });
  writeFileSync(
    "review/plan.json",
    JSON.stringify({ base, from, upstream, nightly }, null, 2) + "\n",
  );
  writeFileSync(
    "review/commits.txt",
    git(["log", "--reverse", "--format=fuller", `${from}...${upstream}`]),
  );
  writeFileSync(
    "review/upstream.diff",
    git(["diff", "--no-ext-diff", from, upstream, "--", ".", ":!.repos"]),
  );
  writeFileSync("review/overlay.json", readFileSync(".github/t2code/overlay.json"));
  for (const path of readJson(".github/t2code/overlay.json").files) {
    mkdirSync(resolve("review/fork-files", path, ".."), { recursive: true });
    cpSync(path, resolve("review/fork-files", path));
  }
  output({ ready: true, base, upstream, tag: nightly.tag });
}
export function validateOverlay(candidate, accepted) {
  if (JSON.stringify(candidate.files) !== JSON.stringify(accepted.files))
    throw new Error("Agent cannot change added files");
  if (!Array.isArray(candidate.replacements) || candidate.replacements.length > 150)
    throw new Error("Invalid replacement list");
  const fixed = accepted.replacements.filter(
    (rule) => !/^(apps|packages)\/[^/]+\/src\//.test(rule.path),
  );
  for (const rule of fixed) {
    if (!candidate.replacements.some((next) => JSON.stringify(next) === JSON.stringify(rule)))
      throw new Error(`Agent changed packaging controls: ${rule.path}`);
  }
  for (const rule of candidate.replacements) {
    if (
      !/^(apps|packages)\/[^/]+\/src\/[A-Za-z0-9_./-]+\.(ts|tsx|js|mjs)$/.test(rule.path) &&
      !fixed.some((known) => JSON.stringify(known) === JSON.stringify(rule))
    )
      throw new Error(`Agent patch outside runtime source: ${rule.path}`);
  }
}
function propose() {
  const context = resolve(process.env.T2_SYNC_CONTEXT);
  const state = readJson(resolve(context, "plan.json"));
  const result = readJson(resolve(context, "agent-output.json"));
  const base = assertSha(state.base),
    upstream = assertSha(state.upstream);
  if (result.decision !== "ready") throw new Error(`Analytics review blocked: ${result.summary}`);
  if (api("git/ref/heads/main").object.sha !== base)
    throw new Error("Main advanced; retry against its new state");
  verifyNightly(state.nightly);
  if (state.nightly.commit !== upstream) throw new Error("Nightly source mismatch");
  const accepted = readJson(resolve(controlRoot, ".github/t2code/overlay.json"));
  if (!Array.isArray(result.edits) || result.edits.length > 1)
    throw new Error("Expected at most one overlay edit");
  let overlay = accepted;
  if (result.edits.length) {
    const edit = result.edits[0];
    if (
      edit.path !== ".github/t2code/overlay.json" ||
      typeof edit.content !== "string" ||
      edit.content.length > 150_000
    )
      throw new Error("Invalid agent edit");
    overlay = JSON.parse(edit.content);
    validateOverlay(overlay, accepted);
  }
  git(["fetch", "--no-tags", "https://github.com/pingdotgg/t3code.git", upstream]);
  git(["switch", "-C", branch, base]);
  git(["read-tree", "--reset", "-u", upstream]);
  for (const path of [".github/workflows", ".github/t2code", ".github/CODEOWNERS"]) {
    rmSync(path, { recursive: true, force: true });
    cpSync(resolve(controlRoot, path), path, { recursive: true });
  }
  for (const path of accepted.files) {
    mkdirSync(resolve(path, ".."), { recursive: true });
    cpSync(resolve(controlRoot, path), path);
  }
  writeFileSync(".github/t2code/upstream.json", JSON.stringify(state.nightly, null, 2) + "\n");
  writeFileSync(".github/t2code/overlay.json", JSON.stringify(overlay, null, 2) + "\n");
  apply();
  git(["add", "--all"]);
  verify();
  const tree = git(["write-tree"]).trim();
  const message = `chore(sync): follow ${state.nightly.tag}\n\n${result.summary}\n\nUpstream: ${upstream}\n`;
  const sha = git([
    "-c",
    "user.name=github-actions[bot]",
    "-c",
    "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "commit-tree",
    tree,
    "-p",
    base,
    "-p",
    upstream,
    "-m",
    message,
  ]).trim();
  git(["update-ref", `refs/heads/${branch}`, sha]);
  // The branch is dedicated to generated snapshots; never rewrite main or a human branch.
  git(["push", "--force-with-lease", "origin", `${sha}:refs/heads/${branch}`]);
  const existing = api(`pulls?state=open&head=shirubasoft:${branch}`)[0];
  const body = `Follow upstream nightly https://github.com/pingdotgg/t3code/releases/tag/${state.nightly.tag}, source ${upstream}.\n\n${result.summary}\n\nApplication changes are limited to the recorded analytics patches and installer metadata. Full CI must pass before merging.\n\nModel: Codex configured model, high reasoning. Harness: isolated Codex CLI.`;
  const pr = existing
    ? api(
        `pulls/${existing.number}`,
        { body, title: `chore(sync): follow ${state.nightly.tag}` },
        "PATCH",
      )
    : api("pulls", {
        base: "main",
        head: branch,
        title: `chore(sync): follow ${state.nightly.tag}`,
        body,
      });
  output({ sha, pr: pr.number });
}
function merge() {
  const sha = assertSha(process.env.T2_CANDIDATE_SHA),
    base = assertSha(process.env.T2_BASE_SHA);
  const number = process.env.T2_SYNC_PR;
  if (!/^\d+$/.test(number ?? "")) throw new Error("Invalid PR number");
  const pr = api(`pulls/${number}`);
  if (
    pr.state !== "open" ||
    pr.head.sha !== sha ||
    pr.head.ref !== branch ||
    pr.head.repo.full_name !== repository ||
    pr.base.ref !== "main" ||
    api("git/ref/heads/main").object.sha !== base
  )
    throw new Error("Candidate or main changed during validation");
  api(`statuses/${sha}`, {
    state: "success",
    context: "T2 trusted validation",
    description: "Pinned upstream analytics review and complete CI passed",
    target_url: `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  });
  const merged = api(`pulls/${number}/merge`, { sha, merge_method: "merge" }, "PUT");
  if (!merged.merged) throw new Error(`Merge failed: ${merged.message}`);
  const tag = process.env.T2_NIGHTLY_TAG;
  nightlyVersion(tag);
  dispatchRelease(merged.sha, tag);
  console.log(`Merged ${pr.html_url}; dispatched ${tag} for ${merged.sha}`);
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  if (process.argv[2] === "plan") plan();
  else if (process.argv[2] === "propose") propose();
  else if (process.argv[2] === "merge") merge();
  else if (process.argv[2] === "retry-release") {
    const tag = process.env.T2_NIGHTLY_TAG;
    nightlyVersion(tag);
    if (!releaseInProgress(tag)) dispatchRelease(process.env.T2_RELEASE_SHA, tag);
  } else throw new Error("Expected plan, propose, merge or retry-release");
}
