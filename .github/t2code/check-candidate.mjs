import * as NodeChildProcess from "node:child_process";
const { spawnSync } = NodeChildProcess;
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
const { resolve } = NodePath;
import { api, assertSha, isProtected } from "./sync.mjs";
import { baselinePath, verifyBaseline } from "./privacy-review.mjs";
import { loadPolicy, verifySource } from "../../scripts/verify-private-build.mjs";

export async function checkCandidate(directory) {
  const candidate = resolve(directory);
  const base = assertSha(process.env.T2_BASE_SHA);
  const sha = assertSha(process.env.T2_CANDIDATE_SHA);
  if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch" && base !== process.env.GITHUB_SHA) {
    throw new Error("Dispatched validation must use the workflow's exact accepted base.");
  }
  const diff = spawnSync("git", ["-C", candidate, "diff", "--name-only", "-z", base, sha], {
    encoding: "utf8",
  });
  if (diff.status !== 0) throw new Error(diff.stderr);
  const paths = diff.stdout.split("\0").filter(Boolean);
  const changedControls = paths.filter((path) => isProtected(path) && path !== baselinePath);
  // Human-authored PRs can update controls through review. Automatic syncs cannot.
  if (process.env.T2_SYNC_PR !== "0" && changedControls.length) {
    throw new Error(`Automatic migration changed trusted controls:\n${changedControls.join("\n")}`);
  }
  const policy = loadPolicy();
  if (sha !== base && (process.env.T2_SYNC_PR !== "0" || paths.includes(baselinePath))) {
    const baseline = JSON.parse(NodeFS.readFileSync(resolve(candidate, baselinePath), "utf8"));
    Object.assign(
      policy,
      await verifyBaseline(candidate, base, baseline, process.env.GITHUB_REPOSITORY, api),
    );
  }
  const violations = verifySource(candidate, policy);
  if (violations.length) throw new Error(`Privacy checks failed:\n${violations.join("\n")}`);
  console.log("Exact candidate passed independent review and fixed privacy controls.");
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(resolve(process.argv[1])).href)
  await checkCandidate(process.argv[2]);
