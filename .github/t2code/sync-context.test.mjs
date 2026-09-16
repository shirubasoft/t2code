import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { reviewContext } from "./sync.mjs";

const Assert = NodeAssert;
const { execFileSync } = NodeChildProcess;
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = NodeFS;
const { tmpdir } = NodeOS;
const { join } = NodePath;
const { test } = NodeTest;

test("large upstream changes remain complete on disk while the initial prompt stays small", () => {
  const root = mkdtempSync(join(tmpdir(), "t2-review-context-"));
  try {
    const source = join(root, "source");
    const git = (...args) => execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim();
    execFileSync("git", ["init", "--quiet", source]);
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    writeFileSync(join(source, "large.ts"), "old\n");
    writeFileSync(join(source, "deleted.ts"), "removed\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    const base = git("rev-parse", "HEAD");
    const large = "changed line of source\n".repeat(40_000) + "LAST_LINE_SENTINEL\n";
    writeFileSync(join(source, "large.ts"), large);
    rmSync(join(source, "deleted.ts"));
    git("add", "--all");
    git("commit", "--quiet", "-m", "upstream");
    const upstream = git("rev-parse", "HEAD");
    const review = join(root, "review");
    const prompt = reviewContext({ base, upstream, start: base }, source, review);
    Assert.ok(prompt.length < 2000);
    Assert.match(prompt, /\/source/);
    Assert.match(prompt, /\/review\/upstream.diff/);
    Assert.deepEqual(JSON.parse(readFileSync(join(review, "changed-files.json"), "utf8")), [
      "deleted.ts",
      "large.ts",
    ]);
    const diff = readFileSync(join(review, "upstream.diff"), "utf8");
    Assert.ok(diff.length > 750_000);
    Assert.match(diff, /\+LAST_LINE_SENTINEL\n/);
    Assert.match(diff, /deleted file mode/);
    Assert.equal(readFileSync(join(source, "large.ts"), "utf8"), large);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
