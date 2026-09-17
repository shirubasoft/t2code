import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { inventory, loadPolicy, verifyBoundaries } from "../../scripts/verify-private-build.mjs";

export const baselinePath = "scripts/private-build-baseline.json";
const sha = /^[0-9a-f]{40}$/;
const digest = /^[0-9a-f]{64}$/;

function git(cwd, args) {
  return NodeChildProcess.execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
    { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
}

export function reviewTree(cwd) {
  // The reviewer reads the worktree. Bind its decision to the staged bytes and
  // modes, excluding only the baseline that the controller generates afterward.
  git(cwd, ["diff", "--quiet", "--no-ext-diff", "--no-textconv"]);
  if (git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))
    throw new Error("Untracked files cannot enter a privacy review.");
  const entries = git(cwd, ["ls-files", "--stage", "-z"])
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = /^(\d{6}) ([0-9a-f]{40}) 0\t([\s\S]+)$/.exec(entry);
      if (!match) throw new Error("Resolve all merge conflicts before privacy review.");
      return [match[3], match[1], match[2]];
    })
    .filter(([path]) => path !== baselinePath);
  return NodeCrypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export function reviewContext(base, cwd, policy = loadPolicy()) {
  if (!sha.test(base)) throw new Error("Expected the accepted base SHA.");
  const actual = inventory(cwd);
  const violations = [...actual.violations, ...verifyBoundaries(cwd, policy)];
  if (violations.length)
    throw new Error(`Non-negotiable privacy checks failed:\n${violations.join("\n")}`);
  const paths = new Set([...Object.keys(policy.capabilities), ...Object.keys(actual.capabilities)]);
  const risks = [...paths].filter(
    (path) => policy.capabilities[path] !== actual.capabilities[path],
  );
  for (const path of new Set([
    ...Object.keys(policy.dependencies),
    ...Object.keys(actual.dependencies),
  ])) {
    if (JSON.stringify(policy.dependencies[path]) !== JSON.stringify(actual.dependencies[path]))
      risks.push(path);
  }
  return {
    base,
    tree: reviewTree(cwd),
    risks: [...new Set(risks)].sort().map((path) => ({
      path,
      before: policy.capabilities[path] ?? null,
      after: actual.capabilities[path] ?? null,
      dependenciesBefore: policy.dependencies[path] ?? [],
      dependenciesAfter: actual.dependencies[path] ?? [],
    })),
  };
}

export function approveReview(result, context, run, attempt) {
  if (result.decision !== "approve" || result.findings?.length !== 0)
    throw new Error(
      `Independent privacy review rejected the candidate: ${result.summary}\n${JSON.stringify(result.findings)}`,
    );
  if (typeof result.summary !== "string" || !result.summary.trim())
    throw new Error("Missing review summary.");
  const reviewed = result.reviewedPaths;
  if (!Array.isArray(reviewed) || reviewed.some((path) => typeof path !== "string"))
    throw new Error("Missing independently reviewed paths.");
  for (const { path } of context.risks) {
    if (!reviewed.includes(path)) throw new Error(`Independent privacy review missed ${path}`);
  }
  if (
    !sha.test(context.base) ||
    !digest.test(context.tree) ||
    !Number.isSafeInteger(run) ||
    run < 1 ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1
  )
    throw new Error("Invalid privacy review identity.");
  return {
    version: 1,
    base: context.base,
    tree: context.tree,
    run,
    attempt,
    summary: result.summary,
  };
}

export function approvalArtifact(approval) {
  NodeAssert.deepEqual(Object.keys(approval).sort(), [
    "attempt",
    "base",
    "run",
    "summary",
    "tree",
    "version",
  ]);
  if (
    approval.version !== 1 ||
    !sha.test(approval.base) ||
    !digest.test(approval.tree) ||
    !Number.isSafeInteger(approval.run) ||
    approval.run < 1 ||
    !Number.isSafeInteger(approval.attempt) ||
    approval.attempt < 1 ||
    typeof approval.summary !== "string" ||
    !approval.summary.trim()
  )
    throw new Error("Invalid privacy approval artifact identity.");
  const identity = [
    approval.version,
    approval.base,
    approval.tree,
    approval.run,
    approval.attempt,
    approval.summary,
  ];
  const hash = NodeCrypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return `privacy-approval-${approval.attempt}-${hash}`;
}

export function refreshBaseline(approval, base, cwd, policy = loadPolicy()) {
  const context = reviewContext(base, cwd, policy);
  if (approval.version !== 1 || approval.base !== base || approval.tree !== context.tree)
    throw new Error("The candidate changed after independent privacy review.");
  approvalArtifact(approval);
  const actual = inventory(cwd);
  const baseline = {
    version: 1,
    capabilities: actual.capabilities,
    dependencies: actual.dependencies,
    review: approval,
  };
  NodeFS.writeFileSync(NodePath.join(cwd, baselinePath), JSON.stringify(baseline, null, 2) + "\n");
  git(cwd, ["--literal-pathspecs", "add", "--", baselinePath]);
  return baseline;
}

export async function verifyApproval(approval, base, tree, repository, api) {
  if (
    approval?.version !== 1 ||
    approval.base !== base ||
    approval.tree !== tree ||
    !sha.test(base) ||
    !digest.test(tree) ||
    !Number.isSafeInteger(approval.run) ||
    approval.run < 1
  )
    throw new Error("Missing privacy approval for the exact candidate and accepted base.");
  const artifactName = approvalArtifact(approval);
  const run = await api(`repos/${repository}/actions/runs/${approval.run}`);
  if (
    run.head_sha !== base ||
    run.head_branch !== "main" ||
    run.head_repository?.full_name !== repository ||
    run.path !== ".github/workflows/upstream-sync.yml" ||
    !["schedule", "workflow_dispatch"].includes(run.event)
  )
    throw new Error("Privacy approval did not come from the trusted main workflow.");
  const jobs = await api(
    `repos/${repository}/actions/runs/${approval.run}/attempts/${approval.attempt}/jobs?per_page=100`,
  );
  if (
    !jobs.jobs.some(
      (job) => job.name === "Independent privacy review" && job.conclusion === "success",
    )
  )
    throw new Error("The independent privacy reviewer did not succeed.");
  const artifacts = await api(
    `repos/${repository}/actions/runs/${approval.run}/artifacts?per_page=100`,
  );
  if (!artifacts.artifacts.some((artifact) => artifact.name === artifactName && !artifact.expired))
    throw new Error("The trusted reviewer did not publish approval for this source tree.");
}

export async function verifyBaseline(cwd, base, baseline, repository, api) {
  NodeAssert.deepEqual(Object.keys(baseline).sort(), [
    "capabilities",
    "dependencies",
    "review",
    "version",
  ]);
  NodeAssert.equal(baseline.version, 1);
  await verifyApproval(baseline.review, base, reviewTree(cwd), repository, api);
  const actual = inventory(cwd);
  NodeAssert.deepEqual(
    baseline.capabilities,
    actual.capabilities,
    "The baseline must contain exactly the reviewed capabilities.",
  );
  NodeAssert.deepEqual(
    baseline.dependencies,
    actual.dependencies,
    "The baseline must contain exactly the reviewed dependencies.",
  );
  return { capabilities: baseline.capabilities, dependencies: baseline.dependencies };
}

async function main() {
  const command = process.argv[2];
  const cwd = process.cwd();
  const state = JSON.parse(NodeFS.readFileSync(process.env.T2_SYNC_PLAN, "utf8"));
  const context = reviewContext(state.base, cwd);
  if (command === "context") {
    NodeFS.writeFileSync(
      NodePath.resolve(cwd, "../review/privacy-review-context.json"),
      JSON.stringify(context, null, 2) + "\n",
    );
    return;
  }
  if (command === "approve") {
    const result = JSON.parse(NodeFS.readFileSync(process.env.T2_PRIVACY_REVIEW, "utf8"));
    const approval = approveReview(
      result,
      context,
      Number(process.env.GITHUB_RUN_ID),
      Number(process.env.GITHUB_RUN_ATTEMPT),
    );
    NodeFS.writeFileSync(
      NodePath.resolve(cwd, "../privacy-approval.json"),
      JSON.stringify(approval, null, 2) + "\n",
    );
    NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, `artifact=${approvalArtifact(approval)}\n`);
    console.log(approval.summary);
    return;
  }
  throw new Error(`Unknown privacy review operation: ${command}`);
}

if (
  process.argv[1] &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
)
  await main();
