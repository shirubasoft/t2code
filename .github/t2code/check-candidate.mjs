import * as NodeChildProcess from "node:child_process";
const { spawnSync } = NodeChildProcess;
import * as NodePath from "node:path";
const { resolve } = NodePath;
import { assertSha, isProtected } from "./sync.mjs";

const candidate = resolve(process.argv[2]);
const base = assertSha(process.env.T2_BASE_SHA);
const sha = assertSha(process.env.T2_CANDIDATE_SHA);
if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch" && base !== process.env.GITHUB_SHA) {
  throw new Error("Dispatched validation must use the workflow's exact accepted base.");
}
const diff = spawnSync("git", ["-C", candidate, "diff", "--name-only", "-z", base, sha], {
  encoding: "utf8",
});
if (diff.status !== 0) throw new Error(diff.stderr);
const changedControls = diff.stdout.split("\0").filter((path) => path && isProtected(path));
// Human-authored PRs can update controls through review. Automatic syncs cannot.
if (process.env.T2_SYNC_PR !== "0" && changedControls.length) {
  throw new Error(`Automatic migration changed trusted controls:\n${changedControls.join("\n")}`);
}
const guard = spawnSync(
  process.execPath,
  [resolve("scripts/verify-private-build.mjs"), "--source", candidate],
  { stdio: "inherit" },
);
if (guard.status !== 0) process.exit(guard.status ?? 1);
