import * as NodeChildProcess from "node:child_process";
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { inventory, verifySource, verifyArtifacts } from "../../scripts/verify-private-build.mjs";

function fixture(t) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t2-policy-"));
  t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  NodeFS.mkdirSync(NodePath.join(root, "apps/server/src"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(root, "packages/shared/src"), { recursive: true });
  NodeChildProcess.execFileSync("git", ["init", "-q", root]);
  const put = (path, text) => NodeFS.writeFileSync(NodePath.join(root, path), text);
  put("apps/server/package.json", JSON.stringify({ dependencies: { effect: "4.0.0" } }));
  put("apps/server/src/client.ts", 'export const client = () => fetch("http://127.0.0.1:3773");');
  put("apps/server/src/boundary.ts", "export const telemetry = false;");
  const policy = {
    ...inventory(root),
    boundaries: {
      "apps/server/src/boundary.ts": NodeCrypto.createHash("sha256")
        .update("export const telemetry = false;")
        .digest("hex"),
    },
  };
  return { root, put, policy };
}

NodeTest.test("accepted local source passes and ordinary pure changes remain possible", (t) => {
  const { root, put, policy } = fixture(t);
  put("apps/server/src/pure.ts", "export const double = (n) => n * 2;");
  NodeAssert.deepEqual(verifySource(root, policy), []);
});

NodeTest.test("new network client and changes to accepted client both fail", (t) => {
  const { root, put, policy } = fixture(t);
  put(
    "apps/server/src/added.ts",
    'navigator.sendBeacon("https://unknown.example/collect", "private");',
  );
  put("apps/server/src/client.ts", 'export const client = () => fetch("https://unknown.example");');
  const result = verifySource(root, policy);
  NodeAssert.ok(result.some((line) => line.includes("added.ts")));
  NodeAssert.ok(result.some((line) => line.includes("client.ts")));
});

NodeTest.test("changing a privacy boundary without a network call fails", (t) => {
  const { root, put, policy } = fixture(t);
  put("apps/server/src/boundary.ts", "export const telemetry = true;");
  NodeAssert.ok(
    verifySource(root, policy).some((line) => line.includes("privacy boundary changed")),
  );
});

NodeTest.test("a candidate cannot bless a new dependency or exporter", (t) => {
  const { root, put, policy } = fixture(t);
  put(
    "apps/server/package.json",
    JSON.stringify({ dependencies: { effect: "4.0.1", axios: "1", "@sentry/node": "1" } }),
  );
  put(
    "apps/server/src/export.ts",
    'import * as OtlpTracer from "effect/unstable/observability/OtlpTracer"; OtlpTracer.layer({url:"https://unknown.example"});',
  );
  const result = verifySource(root, policy);
  NodeAssert.ok(result.some((line) => line.includes("axios")));
  NodeAssert.ok(result.some((line) => line.includes("@sentry/node")));
  NodeAssert.ok(result.some((line) => line.includes("prohibited telemetry")));
});

NodeTest.test("compiled dependency code is checked and an empty artifact path fails", (t) => {
  const { root, put } = fixture(t);
  NodeFS.mkdirSync(NodePath.join(root, "out"));
  NodeAssert.ok(
    verifyArtifacts(NodePath.join(root, "out")).some((line) => line.includes("no compiled code")),
  );
  put("out/main.cjs", 'exports.endpoint="https://us.i.posthog.com/i/v0/e";');
  NodeAssert.ok(
    verifyArtifacts(NodePath.join(root, "out")).some((line) => line.includes("prohibited code")),
  );
});

NodeTest.test("symlinks cannot escape the reviewed tree", (t) => {
  const { root, policy } = fixture(t);
  NodeFS.symlinkSync(NodeOS.tmpdir(), NodePath.join(root, "apps/server/src/outside"));
  NodeAssert.ok(verifySource(root, policy).some((line) => line.includes("symlinks cannot")));
});

NodeTest.test("test files cannot become an unreviewed runtime transport", (t) => {
  const { root, put, policy } = fixture(t);
  put("apps/server/src/unsafe.test.ts", 'fetch("https://unknown.example")');
  put("apps/server/src/pure.ts", 'import "./unsafe.test";');
  NodeAssert.ok(
    verifySource(root, policy).some((line) => line.includes("runtime imports test code")),
  );
});

NodeTest.test("artifact scan includes external dependency JavaScript", (t) => {
  const { root, put } = fixture(t);
  NodeFS.mkdirSync(NodePath.join(root, "out/node_modules/hidden"), { recursive: true });
  put("out/node_modules/hidden/main.cjs", 'exports.endpoint="https://api.segment.io/v1/track";');
  NodeAssert.ok(
    verifyArtifacts(NodePath.join(root, "out")).some((line) => line.includes("prohibited code")),
  );
});
