import * as NodeAssert from "node:assert/strict";
const assert = NodeAssert;
import * as NodeFS from "node:fs";
const { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, cpSync } = NodeFS;
import * as NodeOS from "node:os";
const { tmpdir } = NodeOS;
import * as NodePath from "node:path";
const { join } = NodePath;
import * as NodeTest from "node:test";
const { test } = NodeTest;
import { apply, verify, git, transform, readJson, controlRoot } from "./overlay.mjs";
import { validateOverlay } from "./sync.mjs";
import { inspectOverlay } from "./review.mjs";

test("patches require one unambiguous anchor and preserve unrelated content", () => {
  assert.equal(
    transform("a\nexport();\nz\n", [{ before: "export();", after: "local();" }]),
    "a\nlocal();\nz\n",
  );
  for (const source of ["changed();", "export(); export();"]) {
    assert.throws(
      () => transform(source, [{ before: "export();", after: "local();" }]),
      /anchor must occur once/,
    );
  }
});

test("agent edits cannot change automation, packaging or added files", () => {
  const accepted = readJson(join(controlRoot, ".github/t2code/overlay.json"));
  validateOverlay(accepted, accepted);
  assert.throws(() => validateOverlay({ ...accepted, files: [] }, accepted), /added files/);
  assert.throws(
    () => validateOverlay({ ...accepted, replacements: [] }, accepted),
    /packaging controls/,
  );
  assert.throws(
    () =>
      validateOverlay(
        {
          ...accepted,
          replacements: [
            ...accepted.replacements,
            { path: ".github/workflows/ci.yml", before: "test", after: "skip" },
          ],
        },
        accepted,
      ),
    /outside analytics source/,
  );
});

test("analytics review can retire a deleted relay test and carry protection to moved source", () => {
  const accepted = readJson(join(controlRoot, ".github/t2code/overlay.json"));
  const replacements = accepted.replacements.filter(
    (rule) => rule.path !== "infra/relay/scripts/deploy.test.ts",
  );
  replacements.push(
    { path: "infra/relay/src/logging.ts", before: "exportLogs()", after: "localLogs()" },
    { path: "scripts/relay/logging.test.ts", before: "exports logs", after: "keeps logs local" },
  );
  validateOverlay({ ...accepted, replacements }, accepted);
});

test("runtime packaging paths, traversal and fork-owned privacy files remain protected", () => {
  const accepted = readJson(join(controlRoot, ".github/t2code/overlay.json"));
  for (const path of [
    "apps/web/src/components/desktopUpdate.logic.ts",
    "packages/shared/src/cliRelease.ts",
    "scripts/build-desktop-artifact.ts",
  ]) {
    const replacements = accepted.replacements.map((rule) =>
      rule.path === path ? { ...rule, after: "redirectRelease()" } : rule,
    );
    assert.throws(
      () => validateOverlay({ ...accepted, replacements }, accepted),
      /packaging controls/,
    );
  }
  for (const path of [
    "apps/web/src/../../../../.github/ci.ts",
    "packages/shared/package.json",
    "packages/shared/src/t2Analytics.ts",
    "scripts/install.sh",
  ]) {
    assert.throws(() =>
      validateOverlay(
        {
          ...accepted,
          replacements: [...accepted.replacements, { path, before: "false", after: "true" }],
        },
        accepted,
      ),
    );
  }
});

test("preflight verifies deleted targets and stale anchors against Git, not working files", () => {
  const root = mkdtempSync(join(tmpdir(), "t2-review-tree-"));
  try {
    git(["init"], root);
    mkdirSync(join(root, "infra/relay/src"), { recursive: true });
    const path = "infra/relay/src/logging.ts";
    writeFileSync(join(root, path), "exportLogs();\n");
    git(["add", "."], root);
    git(
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Source"],
      root,
    );
    const upstream = git(["rev-parse", "HEAD"], root).trim();
    rmSync(join(root, path));
    const rule = { path, before: "exportLogs();", after: "localLogs();" };
    const overlay = {
      files: [],
      replacements: [rule, { ...rule, path: "infra/relay/scripts/deploy.test.ts" }],
    };
    assert.deepEqual(inspectOverlay(overlay, upstream, root), [
      { path, status: "applies", editable: true },
      { path: "infra/relay/scripts/deploy.test.ts", status: "deleted", editable: true },
    ]);
    const stale = inspectOverlay(
      { files: [], replacements: [{ ...rule, before: "oldExporter();" }] },
      upstream,
      root,
    );
    assert.equal(stale[0].status, "stale");
    assert.match(stale[0].error, /anchor must occur once/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real overlay recreates the upstream snapshot without touching its lockfile", () => {
  const root = mkdtempSync(join(tmpdir(), "t2-overlay-"));
  const upstream = readJson(join(controlRoot, ".github/t2code/upstream.json")).commit;
  try {
    git(["worktree", "add", "--detach", root, upstream], controlRoot);
    // Copy only the declarative configuration. Added source comes from trusted controlRoot.
    mkdirSync(join(root, ".github/t2code"), { recursive: true });
    for (const name of ["overlay.json", "upstream.json"])
      cpSync(join(controlRoot, ".github/t2code", name), join(root, ".github/t2code", name));
    const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
    apply(root);
    git(["add", "--all"], root);
    verify(root);
    git(["submodule", "foreach", "--recursive", "true"], root);
    assert.equal(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"), lock);
    const path = join(root, "packages/shared/src/t2Analytics.ts");
    writeFileSync(path, readFileSync(path, "utf8").replace("return false", "return true"));
    assert.throws(() => verify(root), /declared patch/);
  } finally {
    git(["worktree", "remove", "--force", root], controlRoot);
    rmSync(root, { recursive: true, force: true });
  }
});
