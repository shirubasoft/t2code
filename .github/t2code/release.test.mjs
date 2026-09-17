import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";
import { parseUpdateManifest, serializeUpdateManifest } from "../../scripts/lib/update-manifest.ts";

const script = NodeURL.fileURLToPath(new URL("release.mjs", import.meta.url));
const version = "0.0.43-nightly.20260917.1866";
const directories = [];
NodeTest.afterEach(() => {
  for (const path of directories.splice(0)) NodeFS.rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t2-release-test-"));
  directories.push(directory);
  const git = (...args) => {
    const result = NodeChildProcess.spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    NodeAssert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "Bootstrap",
  );
  const upstream = git("rev-parse", "HEAD");
  NodeFS.mkdirSync(NodePath.join(directory, ".github/t2code"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(directory, ".github/t2code/upstream.json"),
    JSON.stringify({
      repository: "pingdotgg/t3code",
      commit: upstream,
      tag: `v${version}`,
      releaseId: 42,
    }),
  );
  git("add", ".github/t2code/upstream.json");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "Pin upstream",
  );
  const sha = git("rev-parse", "HEAD");
  const assets = NodePath.join(directory, "assets");
  NodeFS.mkdirSync(assets);
  const bytes = Buffer.from("installer fixture");
  const hash = NodeCrypto.createHash("sha512").update(bytes).digest("base64");
  for (const [arch, ext] of [
    ["x64", "dmg"],
    ["arm64", "dmg"],
    ["x86_64", "AppImage"],
    ["arm64", "AppImage"],
    ["x64", "exe"],
    ["arm64", "exe"],
  ]) {
    NodeFS.writeFileSync(NodePath.join(assets, `T2-Code-${version}-${arch}.${ext}`), bytes);
  }
  for (const [name, arch, ext] of [
    ["nightly-mac.yml", "arm64", "dmg"],
    ["nightly-mac-x64.yml", "x64", "dmg"],
    ["nightly-win-x64.yml", "x64", "exe"],
    ["nightly-win-arm64.yml", "arm64", "exe"],
    ["nightly-linux.yml", "x86_64", "AppImage"],
    ["nightly-linux-arm64.yml", "arm64", "AppImage"],
  ]) {
    NodeFS.writeFileSync(
      NodePath.join(assets, name),
      `version: ${version}\nfiles:\n  - url: T2-Code-${version}-${arch}.${ext}\n    sha512: ${hash}\n    size: ${bytes.length}\n${ext === "AppImage" ? "    blockMapSize: 4\n" : ""}releaseDate: '2026-09-16T00:00:00.000Z'\n`,
    );
  }
  return {
    directory,
    assets,
    sha,
    upstream,
    assemble: (env = {}) =>
      NodeChildProcess.spawnSync(process.execPath, [script, "assemble", assets], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          T2_RELEASE_VERSION: version,
          T2_NIGHTLY_TAG: `v${version}`,
          T2_RELEASE_SHA: sha,
          GITHUB_REPOSITORY: "shirubasoft/t2code",
          GITHUB_RUN_ID: "42",
          ...env,
        },
      }),
  };
}

NodeTest.test(
  "release assembly records the pinned upstream and hashes each published artifact",
  () => {
    const { assets, sha, upstream, assemble } = fixture();
    const result = assemble();
    NodeAssert.equal(result.status, 0, result.stderr);
    const provenance = JSON.parse(
      NodeFS.readFileSync(NodePath.join(assets, "provenance.json"), "utf8"),
    );
    NodeAssert.equal(provenance.commit, sha);
    NodeAssert.equal(provenance.upstream, upstream);
    NodeAssert.equal(provenance.upstreamTag, `v${version}`);
    NodeAssert.equal(provenance.version, version);
    NodeAssert.equal(provenance.signing, "unsigned");
    const checksums = NodeFS.readFileSync(NodePath.join(assets, "SHA256SUMS"), "utf8")
      .trim()
      .split("\n");
    NodeAssert.equal(checksums.length, NodeFS.readdirSync(assets).length - 1);
    for (const line of checksums) {
      const [digest, name] = line.split("  ");
      NodeAssert.equal(
        digest,
        NodeCrypto.createHash("sha256")
          .update(NodeFS.readFileSync(NodePath.join(assets, name)))
          .digest("hex"),
      );
    }
    NodeAssert.match(
      NodeFS.readFileSync(NodePath.join(assets, "nightly.yml"), "utf8"),
      /arm64\.exe/,
    );
    NodeAssert.match(NodeFS.readFileSync(NodePath.join(assets, "nightly.yml"), "utf8"), /x64\.exe/);
  },
);

NodeTest.test("release assembly rejects external update URLs", () => {
  const { assets, assemble } = fixture();
  const path = NodePath.join(assets, "nightly-linux.yml");
  NodeFS.writeFileSync(
    path,
    NodeFS.readFileSync(path, "utf8").replace("url: T2", "url: https://example.invalid/T2"),
  );
  const result = assemble();
  NodeAssert.notEqual(result.status, 0);
  NodeAssert.match(result.stderr, /External or unsafe update asset/);
});

NodeTest.test("the actual AppImage manifest shape retains its embedded block map size", () => {
  const { assets } = fixture();
  const raw = NodeFS.readFileSync(NodePath.join(assets, "nightly-linux.yml"), "utf8");
  const parsed = parseUpdateManifest(raw, "nightly-linux.yml", "Linux");
  NodeAssert.equal(parsed.files[0].url, `T2-Code-${version}-x86_64.AppImage`);
  NodeAssert.equal(parsed.files[0].blockMapSize, 4);
  NodeAssert.deepEqual(
    parseUpdateManifest(
      serializeUpdateManifest(parsed, { platformLabel: "Linux" }),
      "roundtrip.yml",
      "Linux",
    ),
    parsed,
  );
});

NodeTest.test("release assembly rejects modified installer bytes and missing architectures", () => {
  for (const remove of [false, true]) {
    const { assets, assemble } = fixture();
    const path = NodePath.join(assets, `T2-Code-${version}-arm64.exe`);
    if (remove) NodeFS.rmSync(path);
    else NodeFS.appendFileSync(path, "modified");
    const result = assemble();
    NodeAssert.notEqual(result.status, 0);
    NodeAssert.match(
      result.stderr,
      remove ? /Missing arm64 exe installer/ : /Updater checksum mismatch/,
    );
  }
});

NodeTest.test("release assembly rejects stable feeds and mismatched nightly identities", () => {
  const { assets, assemble } = fixture();
  const wrongVersion = assemble({ T2_RELEASE_VERSION: "0.1.42" });
  NodeAssert.notEqual(wrongVersion.status, 0);
  NodeAssert.match(wrongVersion.stderr, /Version must match/);
  const wrongTag = assemble({
    T2_RELEASE_VERSION: "0.0.43-nightly.20260917.1867",
    T2_NIGHTLY_TAG: "v0.0.43-nightly.20260917.1867",
  });
  NodeAssert.notEqual(wrongTag.status, 0);
  const fresh = fixture();
  NodeFS.writeFileSync(NodePath.join(fresh.assets, "latest.yml"), "stable feed");
  const stable = fresh.assemble();
  NodeAssert.notEqual(stable.status, 0);
  NodeAssert.match(stable.stderr, /Stable updater feed/);
});
