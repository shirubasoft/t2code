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
    /outside runtime source/,
  );
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
