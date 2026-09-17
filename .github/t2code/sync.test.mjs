import * as NodeAssert from "node:assert/strict";
const assert = NodeAssert;
import * as NodeChildProcess from "node:child_process";
const { spawnSync } = NodeChildProcess;
import * as NodeFS from "node:fs";
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = NodeFS;
import * as NodeOS from "node:os";
const { tmpdir } = NodeOS;
import * as NodePath from "node:path";
const { join, delimiter } = NodePath;
import * as NodeTest from "node:test";
const { test } = NodeTest;
import { controlRoot } from "./overlay.mjs";

test("planning rejects an advanced main even when its commit diff exceeds the process buffer", () => {
  const root = mkdtempSync(join(tmpdir(), "t2-sync-main-"));
  const output = join(root, "output");
  try {
    writeFileSync(
      join(root, "gh"),
      `#!${process.execPath}
const sha = "f".repeat(40);
const endpoint = process.argv[3];
if (endpoint === "repos/shirubasoft/t2code/git/ref/heads/main") {
  process.stdout.write(JSON.stringify({ object: { type: "commit", sha } }));
} else if (endpoint === "repos/shirubasoft/t2code/commits/main") {
  process.stdout.write(JSON.stringify({ sha, files: [{ patch: "x".repeat(2 * 1024 * 1024) }] }));
} else {
  throw new Error("Unexpected API endpoint: " + endpoint);
}
`,
      { mode: 0o755 },
    );
    const result = spawnSync(
      process.execPath,
      [join(controlRoot, ".github/t2code/sync.mjs"), "plan"],
      {
        cwd: controlRoot,
        env: {
          ...process.env,
          PATH: `${root}${delimiter}${process.env.PATH}`,
          GITHUB_OUTPUT: output,
        },
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    assert.equal(result.status, 0, result.stderr.slice(0, 1000));
    assert.equal(readFileSync(output, "utf8"), "ready=false\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
