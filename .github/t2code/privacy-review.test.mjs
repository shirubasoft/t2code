import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { fileDigest, inventory, verifySource } from "../../scripts/verify-private-build.mjs";
import {
  approvalArtifact,
  approveReview,
  baselinePath,
  refreshBaseline,
  reviewContext,
  reviewTree,
  verifyApproval,
  verifyBaseline,
} from "./privacy-review.mjs";
import { assertEditable } from "./sync.mjs";

const repository = "shirubasoft/t2code";

function fixture(t) {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t2-review-"));
  t.after(() => NodeFS.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    NodeChildProcess.execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
      { cwd, encoding: "utf8" },
    ).trim();
  const put = (path, value) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cwd, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(cwd, path), value);
  };
  git("init", "-q");
  put("apps/server/package.json", JSON.stringify({ dependencies: { effect: "4" } }));
  put("apps/server/src/network.ts", 'export const local = () => fetch("http://127.0.0.1:3773");\n');
  put("apps/server/src/boundary.ts", "export const telemetry = false;\n");
  put("apps/server/src/pure.ts", "export const value = 1;\n");
  put(baselinePath, "{}\n");
  git("add", "--all");
  git("commit", "-qm", "accepted");
  const base = git("rev-parse", "HEAD");
  const actual = inventory(cwd);
  const policy = {
    ...actual,
    boundaries: {
      "apps/server/src/boundary.ts": fileDigest(
        "",
        Buffer.from("export const telemetry = false;\n"),
      ),
    },
  };
  put(
    "apps/server/src/network.ts",
    'export const local = () => fetch("http://127.0.0.1:3773/api");\n',
  );
  git("add", "--all");
  const context = reviewContext(base, cwd, policy);
  const result = {
    decision: "approve",
    summary: "Only the local API path changes.",
    findings: [],
    reviewedPaths: context.risks.map(({ path }) => path),
  };
  const approval = approveReview(result, context, 123, 1);
  const calls = [];
  const run = {
    head_sha: base,
    head_branch: "main",
    head_repository: { full_name: repository },
    path: ".github/workflows/upstream-sync.yml",
    event: "schedule",
  };
  const jobs = { jobs: [{ name: "Independent privacy review", conclusion: "success" }] };
  const artifacts = { artifacts: [{ name: approvalArtifact(approval), expired: false }] };
  const api = async (path) => {
    calls.push(path);
    if (path.endsWith("/runs/123")) return run;
    if (path.endsWith("/attempts/1/jobs?per_page=100")) return jobs;
    if (path.endsWith("/artifacts?per_page=100")) return artifacts;
    throw new Error(`Unexpected API request: ${path}`);
  };
  return {
    cwd,
    git,
    put,
    base,
    policy,
    context,
    result,
    approval,
    api,
    calls,
    run,
    jobs,
    artifacts,
  };
}

NodeTest.test(
  "reviewed implementation changes refresh exact hashes without changing fixed controls",
  async (t) => {
    const f = fixture(t);
    NodeAssert.ok(verifySource(f.cwd, f.policy).length);
    const baseline = refreshBaseline(f.approval, f.base, f.cwd, f.policy);
    NodeAssert.equal(reviewTree(f.cwd), f.context.tree);
    const approved = await verifyBaseline(f.cwd, f.base, baseline, repository, f.api);
    NodeAssert.deepEqual(verifySource(f.cwd, { ...f.policy, ...approved }), []);
    NodeAssert.equal(f.calls.length, 3);
    NodeAssert.throws(() => assertEditable(baselinePath));
  },
);

NodeTest.test("a rejection or incomplete review cannot refresh the baseline", (t) => {
  const f = fixture(t);
  for (const result of [
    { ...f.result, decision: "reject" },
    {
      ...f.result,
      findings: [
        { path: "apps/server/src/network.ts", reason: "external request", repair: "remove it" },
      ],
    },
    { ...f.result, reviewedPaths: [] },
  ])
    NodeAssert.throws(() => approveReview(result, f.context, 123, 1));
});

NodeTest.test(
  "approval cannot be reused after any source change, including pure code",
  async (t) => {
    const f = fixture(t);
    f.put("apps/server/src/pure.ts", "export const value = 2;\n");
    NodeAssert.throws(() => reviewTree(f.cwd));
    f.git("add", "--all");
    NodeAssert.throws(() => refreshBaseline(f.approval, f.base, f.cwd, f.policy), /changed after/);
    await NodeAssert.rejects(
      verifyApproval(f.approval, f.base, reviewTree(f.cwd), repository, f.api),
      /exact candidate/,
    );
  },
);

NodeTest.test("file deletion and executable-mode changes change the reviewed tree", (t) => {
  const f = fixture(t);
  f.git("update-index", "--chmod=+x", "apps/server/src/pure.ts");
  NodeFS.chmodSync(NodePath.join(f.cwd, "apps/server/src/pure.ts"), 0o755);
  NodeAssert.notEqual(reviewTree(f.cwd), f.context.tree);
  f.git("rm", "-f", "apps/server/src/pure.ts");
  NodeAssert.notEqual(reviewTree(f.cwd), f.context.tree);
});

NodeTest.test("untracked source and unresolved conflicts cannot be approved", (t) => {
  const f = fixture(t);
  f.put("apps/server/src/untracked.ts", "export const sneaky = true;\n");
  NodeAssert.throws(() => reviewTree(f.cwd), /Untracked/);
  NodeFS.unlinkSync(NodePath.join(f.cwd, "apps/server/src/untracked.ts"));
  const blob = f.git("rev-parse", "HEAD:apps/server/src/pure.ts");
  NodeChildProcess.execFileSync("git", ["update-index", "--index-info"], {
    cwd: f.cwd,
    input: `0 ${"0".repeat(40)}\tapps/server/src/pure.ts\n100644 ${blob} 1\tapps/server/src/pure.ts\n100644 ${blob} 2\tapps/server/src/pure.ts\n`,
  });
  NodeAssert.throws(() => reviewTree(f.cwd));
});

NodeTest.test("review approval cannot override fixed boundaries or prohibited telemetry", (t) => {
  const f = fixture(t);
  f.put("apps/server/src/boundary.ts", "export const telemetry = true;\n");
  f.git("add", "--all");
  NodeAssert.throws(() => reviewContext(f.base, f.cwd, f.policy), /privacy boundary changed/);
  f.put("apps/server/src/boundary.ts", "export const telemetry = false;\n");
  f.put(
    "apps/server/src/network.ts",
    'navigator.sendBeacon("https://us.i.posthog.com/i/v0/e", "private");\n',
  );
  f.git("add", "--all");
  NodeAssert.throws(() => reviewContext(f.base, f.cwd, f.policy), /prohibited telemetry/);
});

NodeTest.test(
  "approval requires the trusted workflow, base, repository and reviewer job",
  async (t) => {
    const cases = [
      (f) => {
        f.run.head_branch = "candidate";
      },
      (f) => {
        f.run.head_sha = "a".repeat(40);
      },
      (f) => {
        f.run.head_repository.full_name = "attacker/fork";
      },
      (f) => {
        f.run.path = ".github/workflows/other.yml";
      },
      (f) => {
        f.run.event = "pull_request";
      },
      (f) => {
        f.jobs.jobs[0].conclusion = "failure";
      },
      (f) => {
        f.jobs.jobs[0].name = "agent";
      },
      (f) => {
        f.artifacts.artifacts = [];
      },
      (f) => {
        f.artifacts.artifacts[0].expired = true;
      },
    ];
    for (const change of cases) {
      const f = fixture(t);
      change(f);
      await NodeAssert.rejects(
        verifyApproval(f.approval, f.base, f.context.tree, repository, f.api),
      );
    }
  },
);

NodeTest.test(
  "candidate-authored approval metadata and extra baseline permissions fail",
  async (t) => {
    const f = fixture(t);
    const baseline = refreshBaseline(f.approval, f.base, f.cwd, f.policy);
    await NodeAssert.rejects(
      verifyApproval(
        { ...f.approval, summary: "forged approval" },
        f.base,
        f.context.tree,
        repository,
        f.api,
      ),
      /did not publish/,
    );
    await NodeAssert.rejects(
      verifyBaseline(f.cwd, f.base, { ...baseline, injected: "payload" }, repository, f.api),
    );
    await NodeAssert.rejects(
      verifyBaseline(
        f.cwd,
        f.base,
        {
          ...baseline,
          capabilities: { ...baseline.capabilities, "apps/server/src/future.ts": "a".repeat(64) },
        },
        repository,
        f.api,
      ),
    );
    await NodeAssert.rejects(
      verifyBaseline(
        f.cwd,
        f.base,
        {
          ...baseline,
          dependencies: { ...baseline.dependencies, "apps/other/package.json": ["telemetry-sdk"] },
        },
        repository,
        f.api,
      ),
    );
  },
);

NodeTest.test("new dependencies and removed capabilities require independent review", (t) => {
  const f = fixture(t);
  f.put(
    "apps/server/package.json",
    JSON.stringify({ dependencies: { effect: "4", another: "1" } }),
  );
  f.git("rm", "-f", "apps/server/src/network.ts");
  f.git("add", "--all");
  const context = reviewContext(f.base, f.cwd, f.policy);
  NodeAssert.ok(context.risks.some((risk) => risk.path === "apps/server/package.json"));
  NodeAssert.ok(
    context.risks.some((risk) => risk.path === "apps/server/src/network.ts" && risk.after === null),
  );
});
