import * as NodeChildProcess from "node:child_process";
const { execFileSync, spawnSync } = NodeChildProcess;
import * as NodeFS from "node:fs";
const { mkdtempSync, readFileSync, rmSync } = NodeFS;
import * as NodeOS from "node:os";
const { tmpdir } = NodeOS;
import * as NodePath from "node:path";
const { join } = NodePath;
import * as NodeUtil from "node:util";
import { assertSha } from "./overlay.mjs";
import { forkRepository } from "./nightly.mjs";

const maxAttempts = 3;
const cooldownMs = 6 * 60 * 60 * 1000;

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}
function api(path) {
  return JSON.parse(gh(["api", `repos/${forkRepository}/${path}`]));
}
export function feedbackName(base, upstream) {
  return `sync-feedback-${assertSha(base)}-${assertSha(upstream)}`;
}

export function retryPlan(previous, now = Date.now()) {
  if (!previous) return { ready: true, attempt: 1 };
  if (!Number.isInteger(previous.attempt) || previous.attempt < 0 || previous.attempt > maxAttempts)
    throw new Error("Invalid sync feedback attempt");
  if (!Number.isFinite(Date.parse(previous.finishedAt)))
    throw new Error("Invalid sync feedback timestamp");
  if (previous.attempt < maxAttempts) return { ready: true, attempt: previous.attempt + 1 };
  const retryAt = Date.parse(previous.finishedAt) + cooldownMs;
  return now < retryAt
    ? { ready: false, retryAt: new Date(retryAt).toISOString() }
    : { ready: true, attempt: 1 };
}

function downloadFile(runId, name, filename) {
  const directory = mkdtempSync(join(tmpdir(), "t2-sync-feedback-"));
  try {
    gh([
      "run",
      "download",
      String(runId),
      "--repo",
      forkRepository,
      "--name",
      name,
      "--dir",
      directory,
    ]);
    return readFileSync(join(directory, filename), "utf8");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function restoreFeedback(base, upstream) {
  const name = feedbackName(base, upstream);
  const artifacts = api(`actions/artifacts?name=${name}&per_page=100`).artifacts;
  for (const artifact of artifacts.sort((a, b) => b.id - a.id)) {
    if (
      artifact.expired ||
      artifact.workflow_run.head_branch !== "main" ||
      artifact.workflow_run.head_sha !== base
    )
      continue;
    const run = api(`actions/runs/${artifact.workflow_run.id}`);
    if (
      run.path !== ".github/workflows/upstream-sync.yml" ||
      !["schedule", "workflow_dispatch"].includes(run.event) ||
      run.status !== "completed"
    )
      continue;
    const feedback = JSON.parse(downloadFile(run.id, name, "feedback.json"));
    if (
      feedback.version !== 1 ||
      feedback.base !== base ||
      feedback.upstream !== upstream ||
      feedback.runId !== run.id
    )
      throw new Error("Sync feedback does not match its workflow run and source");
    return feedback;
  }
}

export function makeFeedback({
  plan,
  previous,
  runId,
  results,
  agentOutput,
  failures,
  now = Date.now(),
}) {
  // A lost runner has not produced a review. Preserve the remaining repair
  // budget so the next scheduled run can continue when the runner returns.
  const attempt = agentOutput === undefined ? plan.attempt - 1 : plan.attempt;
  return {
    version: 1,
    base: plan.base,
    upstream: plan.upstream,
    runId,
    attempt,
    finishedAt: new Date(now).toISOString(),
    results,
    agentOutput: agentOutput ?? previous?.agentOutput ?? null,
    failures:
      agentOutput === undefined
        ? [...(previous?.failures ?? []), ...failures].slice(-12)
        : failures,
    history: [
      ...(previous?.history ?? []),
      {
        runId,
        attempt,
        results,
        failures: failures.map(({ name, conclusion }) => ({ name, conclusion })),
      },
    ].slice(-9),
  };
}

export function collectFeedback(plan, previous, runId, results) {
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error("Invalid workflow run ID");
  const artifacts = api(`actions/runs/${runId}/artifacts?per_page=100`).artifacts;
  const review = artifacts.find(
    (artifact) => artifact.name === "analytics-review" && !artifact.expired,
  );
  const agentOutput = review
    ? downloadFile(runId, "analytics-review", "agent-output.json")
    : undefined;
  const pages = JSON.parse(
    gh([
      "api",
      `repos/${forkRepository}/actions/runs/${runId}/jobs?per_page=100`,
      "--paginate",
      "--slurp",
    ]),
  );
  let remaining = 160_000;
  const failures = pages
    .flatMap((page) => page.jobs)
    .filter((job) => ["failure", "cancelled", "timed_out"].includes(job.conclusion))
    .map((job) => {
      const args = ["api", `repos/${forkRepository}/actions/jobs/${job.id}/logs`];
      const options = {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      };
      let logs = spawnSync("gh", args, options);
      // Newer gh versions reject ANSI output even when it is captured. Accept
      // it into memory and strip terminal controls before storing the feedback.
      if (logs.status !== 0 && logs.stderr.includes("--allow-escape-sequences"))
        logs = spawnSync("gh", [...args, "--allow-escape-sequences"], options);
      const log =
        logs.status === 0
          ? NodeUtil.stripVTControlCharacters(logs.stdout).slice(-Math.min(remaining, 60_000))
          : `Job log unavailable: ${logs.stderr || logs.error?.message || "runner did not upload logs"}`;
      const retained = remaining > 0 ? log.slice(-remaining) : "Log budget exhausted";
      remaining = Math.max(0, remaining - retained.length);
      return {
        name: job.name,
        conclusion: job.conclusion,
        steps: job.steps
          .filter((step) => step.conclusion === "failure" || step.status === "in_progress")
          .map((step) => step.name),
        log: retained,
      };
    });
  return makeFeedback({ plan, previous, runId, results, agentOutput, failures });
}
