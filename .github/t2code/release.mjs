import * as NodeCrypto from "node:crypto";
const { createHash } = NodeCrypto;
import * as NodeChildProcess from "node:child_process";
const { spawnSync } = NodeChildProcess;
import * as NodeFS from "node:fs";
const { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } = NodeFS;
import * as NodePath from "node:path";
const { resolve } = NodePath;
import { nightlyVersion, verifyNightly, forkRelease, forkRepository } from "./nightly.mjs";
import { assertSha } from "./overlay.mjs";
import {
  mergeUpdateManifests,
  parseUpdateManifest,
  serializeUpdateManifest,
} from "../../scripts/lib/update-manifest.ts";

const repo = forkRepository;

function command(program, args) {
  const result = spawnSync(program, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${program} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function metadata() {
  const sha = assertSha(process.env.T2_RELEASE_SHA);
  const tag = process.env.T2_NIGHTLY_TAG;
  const version = nightlyVersion(tag);
  command("git", ["fetch", "--no-tags", "origin", "main"]);
  command("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);
  const pin = sourcePin(sha, tag);
  verifyNightly(pin);
  const released = forkRelease(tag);
  if (released && released.target_commitish !== sha)
    throw new Error("Nightly tag already belongs to another fork commit");
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `sha=${sha}\nversion=${version}\ntag=${tag}\nready=${!released || released.draft}\n`,
  );
}

function sourcePin(sha, tag) {
  const pin = JSON.parse(command("git", ["show", `${sha}:.github/t2code/upstream.json`]));
  if (pin.tag !== tag || pin.repository !== "pingdotgg/t3code")
    throw new Error("Release must match the source's accepted upstream nightly");
  assertSha(pin.commit);
  command("git", ["merge-base", "--is-ancestor", pin.commit, sha]);
  return pin;
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
  const tag = process.env.T2_NIGHTLY_TAG;
  if (nightlyVersion(tag) !== version)
    throw new Error("Version must match the upstream nightly tag");
  const sha = assertSha(process.env.T2_RELEASE_SHA);
  const pin = sourcePin(sha, tag);
  const upstream = pin.commit;
  mergeManifests(directory, "nightly-mac.yml", "nightly-mac-x64.yml", "nightly-mac.yml", "macOS");
  mergeManifests(
    directory,
    "nightly-win-x64.yml",
    "nightly-win-arm64.yml",
    "nightly.yml",
    "Windows",
  );
  for (const arch of ["x64", "arm64"]) {
    for (const ext of ["dmg", "AppImage", "exe"]) {
      const artifactArch = ext === "AppImage" && arch === "x64" ? "x86_64" : arch;
      if (!existsSync(resolve(directory, `T2-Code-${version}-${artifactArch}.${ext}`)))
        throw new Error(`Missing ${arch} ${ext} installer.`);
    }
  }
  const provenance = {
    repository: repo,
    commit: sha,
    upstream,
    upstreamTag: tag,
    upstreamReleaseId: pin.releaseId,
    version,
    workflowRun: process.env.GITHUB_RUN_ID,
    signing: "unsigned",
  };
  writeFileSync(resolve(directory, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
  for (const file of readdirSync(directory)) {
    if (file === "builder-debug.yml" || file.endsWith("-win-arm64.yml"))
      rmSync(resolve(directory, file));
    else if (/^latest.*\.yml$/.test(file))
      throw new Error(`Stable updater feed in nightly release: ${file}`);
    else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file))
      throw new Error(`Unsafe release filename: ${file}`);
  }
  for (const name of ["nightly-linux.yml", "nightly-linux-arm64.yml"]) {
    if (!existsSync(resolve(directory, name)))
      throw new Error(`Missing Linux update manifest: ${name}`);
  }
  for (const file of readdirSync(directory).filter((name) => /^nightly.*\.yml$/.test(name))) {
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
    `T2 Code Nightly ${version}\n\nDownload the installer for your operating system and processor. These builds are unsigned; macOS and Windows may require an installation override.\n\nThis distribution runs locally without a product account. Analytics and external diagnostic exporters are disabled in code. Local diagnostics are retained. Provider harnesses use their own credentials. Upstream Git, update, and optional remote-connection features are retained.\n\nUpstream nightly: https://github.com/pingdotgg/t3code/releases/tag/${tag}\nSource: https://github.com/${repo}/commit/${sha}\n${upstream ? `Upstream: https://github.com/pingdotgg/t3code/commit/${upstream}\n` : ""}\nInstall this nightly separately if you use an older 0.1.x T2 release. Its stable update channel does not switch to nightly automatically.\n\nSHA256SUMS covers the attached artifacts. provenance.json records the build source.\n`,
  );
}

function publish() {
  const directory = resolve(process.argv[3]);
  const version = process.env.T2_RELEASE_VERSION;
  const sha = assertSha(process.env.T2_RELEASE_SHA);
  const tag = process.env.T2_NIGHTLY_TAG;
  if (nightlyVersion(tag) !== version)
    throw new Error("Version must match the upstream nightly tag");
  verifyNightly(sourcePin(sha, tag));
  const existing = forkRelease(tag);
  if (existing && (!existing.draft || existing.target_commitish !== sha))
    throw new Error("Refusing to replace an existing published nightly or another source");
  if (!existing)
    command("gh", [
      "release",
      "create",
      tag,
      "--repo",
      repo,
      "--target",
      sha,
      "--title",
      `T2 Code Nightly ${version}`,
      "--notes-file",
      "release-notes.md",
      "--draft",
    ]);
  command("gh", [
    "release",
    "upload",
    tag,
    "--repo",
    repo,
    "--clobber",
    ...readdirSync(directory)
      .sort()
      .map((name) => resolve(directory, name)),
  ]);
  command("gh", [
    "release",
    "edit",
    tag,
    "--repo",
    repo,
    "--draft=false",
    "--prerelease=false",
    "--latest",
  ]);
}

if (process.argv[2] === "metadata") metadata();
else if (process.argv[2] === "assemble") assemble();
else if (process.argv[2] === "publish") publish();
else throw new Error("Expected metadata, assemble or publish.");
