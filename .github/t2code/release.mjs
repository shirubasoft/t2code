import * as NodeCrypto from "node:crypto";
const { createHash } = NodeCrypto;
import * as NodeChildProcess from "node:child_process";
const { spawnSync } = NodeChildProcess;
import * as NodeFS from "node:fs";
const { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } = NodeFS;
import * as NodePath from "node:path";
const { resolve } = NodePath;
import { assertSha } from "./sync.mjs";
import {
  mergeUpdateManifests,
  parseUpdateManifest,
  serializeUpdateManifest,
} from "../../scripts/lib/update-manifest.ts";

const repo = process.env.GITHUB_REPOSITORY;

function command(program, args) {
  const result = spawnSync(program, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${program} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function metadata() {
  const sha = assertSha(process.env.T2_RELEASE_SHA);
  const run = process.env.GITHUB_RUN_NUMBER;
  if (!/^\d+$/.test(run ?? "")) throw new Error("Missing release sequence number.");
  command("git", ["fetch", "--no-tags", "origin", "main"]);
  command("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);
  const releases = JSON.parse(command("gh", ["api", `repos/${repo}/releases?per_page=100`]));
  const exists = releases.some((release) => !release.draft && release.target_commitish === sha);
  const version = `0.1.${run}`;
  appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\nversion=${version}\nready=${!exists}\n`);
}

function mergeManifests(directory, first, second, output, platform) {
  const primary = resolve(directory, first);
  const secondary = resolve(directory, second);
  if (!existsSync(primary) || !existsSync(secondary))
    throw new Error(`Missing ${platform} update manifest.`);
  const merged = mergeUpdateManifests(
    parseUpdateManifest(readFileSync(primary, "utf8"), first, platform),
    parseUpdateManifest(readFileSync(secondary, "utf8"), second, platform),
    platform,
  );
  rmSync(primary);
  rmSync(secondary);
  writeFileSync(
    resolve(directory, output),
    serializeUpdateManifest(merged, { platformLabel: platform }),
  );
}

function assemble() {
  const directory = resolve(process.argv[3]);
  const version = process.env.T2_RELEASE_VERSION;
  if (!/^0\.1\.\d+$/.test(version ?? "")) throw new Error("Invalid release version.");
  const sha = assertSha(process.env.T2_RELEASE_SHA);
  mergeManifests(directory, "latest-mac.yml", "latest-mac-x64.yml", "latest-mac.yml", "macOS");
  mergeManifests(directory, "latest-win-x64.yml", "latest-win-arm64.yml", "latest.yml", "Windows");
  for (const arch of ["x64", "arm64"]) {
    for (const ext of ["dmg", "AppImage", "exe"]) {
      const artifactArch = ext === "AppImage" && arch === "x64" ? "x86_64" : arch;
      if (!existsSync(resolve(directory, `T2-Code-${version}-${artifactArch}.${ext}`)))
        throw new Error(`Missing ${arch} ${ext} installer.`);
    }
  }
  const parents = command("git", ["show", "--format=%P", "--no-patch", sha])
    .split(" ")
    .filter(Boolean);
  const upstream = [sha, ...parents]
    .map(
      (ref) =>
        command("git", ["log", "--format=%B", "-1", ref]).match(/^Upstream: ([0-9a-f]{40})$/m)?.[1],
    )
    .find(Boolean);
  const provenance = {
    repository: repo,
    commit: sha,
    upstream: upstream ?? null,
    version,
    workflowRun: process.env.GITHUB_RUN_ID,
    signing: "unsigned",
  };
  writeFileSync(resolve(directory, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
  for (const file of readdirSync(directory)) {
    if (file === "builder-debug.yml" || file.endsWith("-win-arm64.yml"))
      rmSync(resolve(directory, file));
    else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file))
      throw new Error(`Unsafe release filename: ${file}`);
  }
  for (const file of readdirSync(directory).filter((name) => /^latest.*\.yml$/.test(name))) {
    const manifest = parseUpdateManifest(
      readFileSync(resolve(directory, file), "utf8"),
      file,
      "desktop",
    );
    if (manifest.version !== version) throw new Error(`Wrong updater version in ${file}.`);
    for (const asset of manifest.files) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asset.url))
        throw new Error(`External or unsafe update asset: ${asset.url}`);
      const bytes = readFileSync(resolve(directory, asset.url));
      if (
        bytes.length !== asset.size ||
        createHash("sha512").update(bytes).digest("base64") !== asset.sha512
      )
        throw new Error(`Updater checksum mismatch: ${asset.url}`);
    }
  }
  const hashes = readdirSync(directory)
    .filter((name) => name !== "SHA256SUMS")
    .sort()
    .map(
      (name) =>
        `${createHash("sha256")
          .update(readFileSync(resolve(directory, name)))
          .digest("hex")}  ${name}`,
    )
    .join("\n");
  writeFileSync(resolve(directory, "SHA256SUMS"), hashes + "\n");
  writeFileSync(
    "release-notes.md",
    `T2 Code ${version}\n\nDownload the installer for your operating system and processor. These builds are unsigned; macOS and Windows may require an installation override.\n\nThis distribution runs locally without a product account. It contains no external telemetry. Git and update requests require a user action. Provider harnesses use their own credentials.\n\nSource: https://github.com/${repo}/commit/${sha}\n${upstream ? `Upstream: https://github.com/pingdotgg/t3code/commit/${upstream}\n` : ""}\nSHA256SUMS covers the attached artifacts. provenance.json records the build source.\n`,
  );
}

function publish() {
  const directory = resolve(process.argv[3]);
  const version = process.env.T2_RELEASE_VERSION;
  const sha = assertSha(process.env.T2_RELEASE_SHA);
  if (!/^0\.1\.\d+$/.test(version ?? "")) throw new Error("Invalid release version.");
  command("gh", [
    "release",
    "create",
    `v${version}`,
    "--repo",
    repo,
    "--target",
    sha,
    "--title",
    `T2 Code ${version}`,
    "--notes-file",
    "release-notes.md",
    "--latest",
    ...readdirSync(directory)
      .sort()
      .map((name) => resolve(directory, name)),
  ]);
}

if (process.argv[2] === "metadata") metadata();
else if (process.argv[2] === "assemble") assemble();
else if (process.argv[2] === "publish") publish();
else throw new Error("Expected metadata, assemble or publish.");
