import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { loadPolicy } from "../../scripts/verify-private-build.mjs";
import { checkCandidate } from "./check-candidate.mjs";
import { approvalArtifact, approveReview, baselinePath, reviewContext } from "./privacy-review.mjs";
import { completeCandidate, policy, publishCandidate } from "./sync.mjs";

function fixture(t) {
  const originalDirectory = process.cwd();
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t2-sync-approval-"));
  const candidate = NodePath.join(root, "candidate");
  const remote = NodePath.join(root, "remote.git");
  t.after(() => {
    process.chdir(originalDirectory);
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
    NodeFS.rmSync(root, { recursive: true, force: true });
  });
  const git = (...args) =>
    NodeChildProcess.execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
      { cwd: candidate, encoding: "utf8" },
    ).trim();
  NodeFS.mkdirSync(candidate);
  git("init", "-q");
  git("init", "--bare", "-q", remote);
  git("remote", "add", "origin", remote);
  const controls = loadPolicy();
  const source = NodePath.resolve(import.meta.dirname, "../..");
  for (const path of Object.keys(controls.boundaries)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(candidate, path)), { recursive: true });
    NodeFS.copyFileSync(NodePath.join(source, path), NodePath.join(candidate, path));
  }
  NodeFS.writeFileSync(NodePath.join(candidate, baselinePath), "{}\n");
  git("add", "--all");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  NodeFS.writeFileSync(
    NodePath.join(candidate, "apps/server/src/local-example.ts"),
    'export const local = () => fetch("http://127.0.0.1:3773/api");\n',
  );
  git("add", "--all");
  git("commit", "-qm", "upstream");
  const upstream = git("rev-parse", "HEAD");
  const state = { base, upstream, attempt: 1, head: "", pr: 0 };
  const repository = "shirubasoft/t2code";
  const calls = [];
  const pr = {
    number: 12,
    state: "open",
    draft: false,
    head: { ref: policy.branch, repo: { full_name: repository } },
    base: { ref: "main", sha: base },
  };
  const run = {
    head_sha: base,
    head_branch: "main",
    head_repository: { full_name: repository },
    path: ".github/workflows/upstream-sync.yml",
    event: "workflow_dispatch",
  };
  const artifacts = [];
  const jobs = [{ name: "Independent privacy review", conclusion: "success" }];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, ...options });
    if (url.endsWith("/commits/main")) return Response.json({ sha: pr.base.sha });
    if (url.endsWith("/pulls") && options.method === "POST") {
      pr.body = JSON.parse(options.body).body;
      pr.head.sha = git("rev-parse", `refs/remotes/origin/${policy.branch}`);
      return Response.json(pr);
    }
    if (url.endsWith("/pulls/12")) return Response.json(pr);
    if (url.endsWith("/runs/123")) return Response.json(run);
    if (url.endsWith("/attempts/1/jobs?per_page=100")) return Response.json({ jobs });
    if (url.endsWith("/artifacts?per_page=100")) return Response.json({ artifacts });
    if (url.endsWith("/ci.yml/dispatches")) return new Response(null, { status: 204 });
    throw new Error(`Unexpected API call: ${url}`);
  };
  process.chdir(candidate);
  process.env.GITHUB_REPOSITORY = repository;
  process.env.GITHUB_OUTPUT = NodePath.join(root, "output");
  process.env.T2_BASE_SHA = base;
  process.env.T2_SYNC_PR = "12";
  process.env.GITHUB_SHA = base;
  process.env.GITHUB_EVENT_NAME = "workflow_dispatch";
  return { git, candidate, state, base, pr, calls, jobs, artifacts };
}

async function propose(f) {
  await publishCandidate(f.state, { summary: "Preserve local-only behavior." });
  const context = reviewContext(f.base, f.candidate);
  const approval = approveReview(
    {
      decision: "approve",
      findings: [],
      summary: "All changed capabilities remain local.",
      reviewedPaths: context.risks.map(({ path }) => path),
    },
    context,
    123,
    1,
  );
  f.artifacts.push({ name: approvalArtifact(approval), expired: false });
  return approval;
}

NodeTest.test(
  "publication waits for independent approval, then dispatches and validates only the finalized commit",
  async (t) => {
    const f = fixture(t);
    const approval = await propose(f);
    NodeAssert.equal(f.calls.filter(({ url }) => url.endsWith("/dispatches")).length, 0);
    const proposedSha = f.pr.head.sha;
    await completeCandidate(f.state, approval, proposedSha, 12);
    const finalizedSha = f.git("rev-parse", "HEAD");
    NodeAssert.notEqual(finalizedSha, proposedSha);
    NodeAssert.equal(f.git("diff", "--name-only", proposedSha, finalizedSha), baselinePath);
    const dispatches = f.calls.filter(({ url }) => url.endsWith("/dispatches"));
    NodeAssert.equal(dispatches.length, 1);
    NodeAssert.deepEqual(JSON.parse(dispatches[0].body), {
      ref: "main",
      inputs: { pr: "12", sha: finalizedSha, base: f.base },
    });
    NodeAssert.equal(f.git("rev-parse", `refs/remotes/origin/${policy.branch}`), finalizedSha);
    process.env.T2_CANDIDATE_SHA = finalizedSha;
    await checkCandidate(f.candidate);
    NodeFS.appendFileSync(
      NodePath.join(f.candidate, "apps/server/src/local-example.ts"),
      "export const changed = true;\n",
    );
    f.git("commit", "-qam", "unreviewed edit");
    process.env.T2_CANDIDATE_SHA = f.git("rev-parse", "HEAD");
    await NodeAssert.rejects(checkCandidate(f.candidate), /exact candidate/);
  },
);

for (const change of ["head", "base", "review"]) {
  NodeTest.test(`a changed ${change} prevents baseline commit, push and CI dispatch`, async (t) => {
    const f = fixture(t);
    const approval = await propose(f);
    const proposedSha = f.pr.head.sha;
    if (change === "head") f.pr.head.sha = "f".repeat(40);
    if (change === "base") f.pr.base.sha = "f".repeat(40);
    if (change === "review") f.jobs[0].conclusion = "failure";
    await NodeAssert.rejects(completeCandidate(f.state, approval, proposedSha, 12));
    NodeAssert.equal(f.git("rev-parse", "HEAD"), proposedSha);
    NodeAssert.equal(f.git("rev-parse", `refs/remotes/origin/${policy.branch}`), proposedSha);
    NodeAssert.equal(f.calls.filter(({ url }) => url.endsWith("/dispatches")).length, 0);
  });
}
