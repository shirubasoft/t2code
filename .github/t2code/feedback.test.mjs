import * as NodeAssert from "node:assert/strict";
const assert = NodeAssert;
import * as NodeTest from "node:test";
const { test } = NodeTest;
import * as NodeFS from "node:fs";
const { mkdtempSync, writeFileSync, rmSync } = NodeFS;
import * as NodeOS from "node:os";
const { tmpdir } = NodeOS;
import * as NodePath from "node:path";
const { join, delimiter } = NodePath;
import {
  feedbackName,
  retryPlan,
  makeFeedback,
  collectFeedback,
  restoreFeedback,
} from "./feedback.mjs";

const base = "a".repeat(40);
const upstream = "b".repeat(40);
const now = Date.parse("2026-09-19T20:00:00Z");
const plan = { base, upstream, attempt: 1 };
const agentOutput = JSON.stringify({
  decision: "ready",
  summary: "Adapted logging guards",
  edits: [],
});

test("three completed reviews trigger a cooldown and retain the proposed patch", () => {
  let previous;
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.deepEqual(retryPlan(previous, now), { ready: true, attempt });
    previous = makeFeedback({
      plan: { ...plan, attempt },
      previous,
      runId: attempt,
      now,
      results: { analytics: "success", propose: "success", validate: "failure" },
      agentOutput,
      failures: [
        { name: "validate / Test", conclusion: "failure", log: "expected no exported logs" },
      ],
    });
  }
  assert.deepEqual(retryPlan(previous, now), { ready: false, retryAt: "2026-09-20T02:00:00.000Z" });
  assert.deepEqual(retryPlan(previous, now + 6 * 60 * 60 * 1000), { ready: true, attempt: 1 });
  assert.equal(previous.agentOutput, agentOutput);
  assert.equal(previous.failures[0].log, "expected no exported logs");
  assert.equal(previous.history.length, 3);
});

test("a disconnected runner preserves the repair budget and previous candidate", () => {
  const previous = makeFeedback({
    plan,
    runId: 1,
    now,
    agentOutput,
    results: { propose: "failure" },
    failures: [{ name: "propose", conclusion: "failure", log: "Patch anchor must occur once" }],
  });
  const interrupted = makeFeedback({
    plan: { ...plan, attempt: 2 },
    previous,
    runId: 2,
    now,
    results: { analytics: "failure" },
    failures: [{ name: "analytics", conclusion: "failure", log: "Runner lost communication" }],
  });
  assert.equal(interrupted.attempt, 1);
  assert.equal(interrupted.agentOutput, agentOutput);
  assert.equal(interrupted.failures[0].log, "Patch anchor must occur once");
  assert.deepEqual(retryPlan(interrupted, now), { ready: true, attempt: 2 });
});

function githubFixture(t, state) {
  const root = mkdtempSync(join(tmpdir(), "t2-feedback-test-"));
  const originalPath = process.env.PATH;
  const stateFile = join(root, "github.json");
  writeFileSync(stateFile, JSON.stringify(state));
  writeFileSync(
    join(root, "gh"),
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}));
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "download") {
  const directory = args[args.indexOf("--dir") + 1];
  const name = args[args.indexOf("--name") + 1];
  const filename = name === "analytics-review" ? "agent-output.json" : "feedback.json";
  fs.writeFileSync(path.join(directory, filename), name === "analytics-review" ? state.agentOutput : JSON.stringify(state.feedback));
} else if (args[0] === "api") {
  const response = state.responses[args[1]];
  if (response === undefined) throw new Error("Unexpected endpoint: " + args[1]);
  if (response.error) { console.error(response.error); process.exit(1); }
  if (typeof response === "string" && response.includes(String.fromCharCode(27)) && !args.includes("--allow-escape-sequences")) {
    console.error("the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway");
    process.exit(1);
  }
  process.stdout.write(typeof response === "string" ? response : JSON.stringify(response));
} else throw new Error("Unexpected command: " + args.join(" "));
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${root}${delimiter}${originalPath}`;
  t.after(() => {
    process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  });
}

test("completed job logs and the proposed overlay survive a GitHub artifact round trip", (t) => {
  const feedback = makeFeedback({
    plan,
    runId: 17,
    now,
    agentOutput,
    results: { validate: "failure" },
    failures: [],
  });
  const name = feedbackName(base, upstream);
  githubFixture(t, {
    agentOutput,
    feedback,
    responses: {
      [`repos/shirubasoft/t2code/actions/artifacts?name=${name}&per_page=100`]: {
        artifacts: [
          { id: 30, expired: false, workflow_run: { id: 18, head_branch: "main", head_sha: base } },
          { id: 29, expired: false, workflow_run: { id: 17, head_branch: "main", head_sha: base } },
        ],
      },
      "repos/shirubasoft/t2code/actions/runs/18": {
        id: 18,
        path: ".github/workflows/ci.yml",
        event: "push",
        status: "completed",
      },
      "repos/shirubasoft/t2code/actions/runs/17": {
        id: 17,
        path: ".github/workflows/upstream-sync.yml",
        event: "schedule",
        status: "completed",
      },
      "repos/shirubasoft/t2code/actions/runs/19/artifacts?per_page=100": {
        artifacts: [{ name: "analytics-review", expired: false }],
      },
      "repos/shirubasoft/t2code/actions/runs/19/jobs?per_page=100": [
        {
          jobs: [
            {
              id: 100,
              name: "validate / Test",
              conclusion: "failure",
              steps: [{ name: "Test", conclusion: "failure" }],
            },
          ],
        },
        {
          jobs: [
            {
              id: 101,
              name: "validate / Check",
              conclusion: "failure",
              steps: [{ name: "Typecheck", conclusion: "failure" }],
            },
          ],
        },
      ],
      "repos/shirubasoft/t2code/actions/jobs/100/logs":
        "\u001b[31mTest failed: exported a log record\u001b[0m",
      "repos/shirubasoft/t2code/actions/jobs/101/logs": "Typecheck failed: missing import",
    },
  });
  const restored = restoreFeedback(base, upstream);
  assert.deepEqual(restored, feedback);
  const collected = collectFeedback({ ...plan, attempt: 2 }, restored, 19, { validate: "failure" });
  assert.equal(collected.attempt, 2);
  assert.equal(collected.agentOutput, agentOutput);
  assert.deepEqual(
    collected.failures.map((failure) => failure.log),
    ["Test failed: exported a log record", "Typecheck failed: missing import"],
  );
  assert.deepEqual(collected.failures[1].steps, ["Typecheck"]);
});

test("missing runner logs and artifacts still produce recoverable feedback", (t) => {
  githubFixture(t, {
    responses: {
      "repos/shirubasoft/t2code/actions/runs/20/artifacts?per_page=100": { artifacts: [] },
      "repos/shirubasoft/t2code/actions/runs/20/jobs?per_page=100": [
        {
          jobs: [
            {
              id: 102,
              name: "analytics",
              conclusion: "failure",
              steps: [{ name: "Review", status: "in_progress" }],
            },
          ],
        },
      ],
      "repos/shirubasoft/t2code/actions/jobs/102/logs": { error: "gh: Not Found (HTTP 404)" },
    },
  });
  const feedback = collectFeedback(plan, undefined, 20, { analytics: "failure" });
  assert.equal(feedback.attempt, 0);
  assert.equal(feedback.agentOutput, null);
  assert.match(feedback.failures[0].log, /Job log unavailable/);
  assert.deepEqual(retryPlan(feedback), { ready: true, attempt: 1 });
});

test("blocked and malformed reviews consume attempts and remain available for repair", () => {
  for (const output of [
    JSON.stringify({ decision: "blocked", summary: "stale patch", edits: [] }),
    "invalid json",
  ]) {
    const feedback = makeFeedback({
      plan,
      runId: 1,
      now,
      agentOutput: output,
      results: { propose: "failure" },
      failures: [],
    });
    assert.deepEqual(retryPlan(feedback, now), { ready: true, attempt: 2 });
    assert.equal(feedback.agentOutput, output);
  }
});

test("feedback is scoped to both accepted controls and upstream source", () => {
  assert.notEqual(feedbackName(base, upstream), feedbackName("c".repeat(40), upstream));
  assert.notEqual(feedbackName(base, upstream), feedbackName(base, "c".repeat(40)));
  assert.throws(() => feedbackName("main", upstream), /complete commit SHA/);
  assert.throws(
    () => retryPlan({ attempt: 4, finishedAt: new Date(now).toISOString() }),
    /attempt/,
  );
  assert.throws(() => retryPlan({ attempt: 3, finishedAt: "invalid" }), /timestamp/);
});
