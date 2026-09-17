import * as NodeChildProcess from "node:child_process";
import { assertSha, git } from "./overlay.mjs";

export const upstreamRepository = "pingdotgg/t3code";
export const forkRepository = "shirubasoft/t2code";
const tagPattern = /^v(\d+\.\d+\.\d+-nightly\.\d{8}\.\d+)$/;

export function nightlyVersion(tag) {
  const match = tagPattern.exec(tag ?? "");
  if (!match || match[0] !== tag) throw new Error("Expected an upstream nightly version tag");
  return match[1];
}
export function github(path, query) {
  return JSON.parse(
    NodeChildProcess.execFileSync(
      "gh",
      ["api", `repos/${path}`, ...(query ? ["--jq", query] : [])],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    ),
  );
}
export function publishedNightly(release) {
  return (
    !release.draft &&
    release.prerelease === true &&
    tagPattern.test(release.tag_name) &&
    Number.isFinite(Date.parse(release.published_at))
  );
}
export function selectNightly(releases, pin) {
  const nightlies = releases
    .filter(publishedNightly)
    .sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at) || a.id - b.id);
  if (!pin.tag) return nightlies.at(-1);
  const index = nightlies.findIndex((release) => release.tag_name === pin.tag);
  if (index === -1 || nightlies[index].id !== pin.releaseId)
    throw new Error("Accepted upstream nightly was removed or replaced");
  return nightlies[index + 1];
}
export function nextNightly(pin) {
  const releases = [];
  // GitHub orders by creation time. Read all pages so publication order, including
  // delayed draft publications, cannot silently drop an intervening nightly.
  for (let page = 1; ; page++) {
    const batch = github(
      `${upstreamRepository}/releases?per_page=100&page=${page}`,
      "map({id,tag_name,draft,prerelease,published_at})",
    );
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  return selectNightly(releases, pin);
}
export function resolveNightly(release) {
  if (!publishedNightly(release)) throw new Error("Upstream release is not a published nightly");
  nightlyVersion(release.tag_name);
  git([
    "fetch",
    "--no-tags",
    `https://github.com/${upstreamRepository}.git`,
    `refs/tags/${release.tag_name}`,
  ]);
  return {
    repository: upstreamRepository,
    commit: assertSha(git(["rev-parse", "FETCH_HEAD^{commit}"]).trim()),
    tag: release.tag_name,
    releaseId: release.id,
  };
}
export function verifyNightly(pin) {
  nightlyVersion(pin.tag);
  const current = resolveNightly(github(`${upstreamRepository}/releases/tags/${pin.tag}`));
  if (
    JSON.stringify(current) !==
    JSON.stringify({
      repository: pin.repository,
      commit: pin.commit,
      tag: pin.tag,
      releaseId: pin.releaseId,
    })
  )
    throw new Error("Pinned upstream nightly identity changed");
}
export function forkRelease(tag) {
  nightlyVersion(tag);
  // Only a genuine 404 means absent. Authentication/rate-limit failures must stop.
  const result = NodeChildProcess.spawnSync(
    "gh",
    ["api", `repos/${forkRepository}/releases/tags/${tag}`],
    { encoding: "utf8" },
  );
  if (result.status === 0) return JSON.parse(result.stdout);
  if (result.stderr.includes("(HTTP 404)")) return undefined;
  throw new Error(`Cannot inspect fork release: ${result.stderr}`);
}
export function releaseInProgress(tag) {
  return github(
    `${forkRepository}/actions/workflows/release.yml/runs?branch=main&per_page=100`,
  ).workflow_runs.some(
    (run) => run.display_title === `T2 nightly ${tag}` && run.status !== "completed",
  );
}
