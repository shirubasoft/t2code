import { git, transform } from "./overlay.mjs";

// Packaging replacements keep their edit while anchors can follow upstream context.
const packagingPaths = new Set([
  "apps/web/src/components/desktopUpdate.logic.ts",
  "apps/web/src/components/desktopUpdate.logic.test.ts",
  "apps/web/src/components/desktopUpdate.toast.test.tsx",
  "apps/web/src/components/sidebar/SidebarUpdateReleaseNotes.test.tsx",
  "packages/shared/src/cliRelease.ts",
  "packages/shared/src/cliRelease.test.ts",
  "packages/ssh/src/tunnel.test.ts",
  "scripts/build-desktop-artifact.ts",
  "scripts/build-desktop-artifact.test.ts",
]);

function analyticsPath(path) {
  return (
    typeof path === "string" &&
    /^(apps|packages|infra|scripts)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(path) &&
    !path.split("/").some((part) => part === ".." || part === ".") &&
    !packagingPaths.has(path)
  );
}

function packagingChange(rule) {
  if (typeof rule.before !== "string" || typeof rule.after !== "string") return null;
  let start = 0;
  while (
    start < rule.before.length &&
    start < rule.after.length &&
    rule.before[start] === rule.after[start]
  ) {
    start += 1;
  }
  let beforeEnd = rule.before.length;
  let afterEnd = rule.after.length;
  while (
    beforeEnd > start &&
    afterEnd > start &&
    rule.before[beforeEnd - 1] === rule.after[afterEnd - 1]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  return JSON.stringify([
    rule.path,
    rule.before.slice(start, beforeEnd),
    rule.after.slice(start, afterEnd),
  ]);
}

export function validateOverlay(candidate, accepted) {
  if (JSON.stringify(candidate.files) !== JSON.stringify(accepted.files))
    throw new Error("Agent cannot change added files");
  if (!Array.isArray(candidate.replacements) || candidate.replacements.length > 150)
    throw new Error("Invalid replacement list");
  const fixed = accepted.replacements.filter((rule) => !analyticsPath(rule.path));
  const fixedChanges = new Set(fixed.map(packagingChange));
  for (const rule of fixed) {
    if (!candidate.replacements.some((next) => packagingChange(next) === packagingChange(rule)))
      throw new Error(`Agent changed packaging controls: ${rule.path}`);
  }
  for (const rule of candidate.replacements) {
    if (accepted.files.includes(rule.path))
      throw new Error(`Agent cannot patch fixed policy files: ${rule.path}`);
    if (!analyticsPath(rule.path) && !fixedChanges.has(packagingChange(rule)))
      throw new Error(`Agent patch outside analytics source: ${rule.path}`);
    if (
      typeof rule.before !== "string" ||
      !rule.before ||
      typeof rule.after !== "string" ||
      rule.before === rule.after
    )
      throw new Error(`Invalid replacement: ${rule.path}`);
  }
}

// Inspect the Git tree, rather than a sparse checkout, to distinguish deleted
// files from files the runner simply has not checked out.
export function inspectOverlay(overlay, upstream, cwd = process.cwd()) {
  const paths = new Set(git(["ls-tree", "-r", "--name-only", upstream], cwd).trim().split("\n"));
  const grouped = new Map();
  for (const rule of overlay.replacements) {
    const rules = grouped.get(rule.path) ?? [];
    rules.push(rule);
    grouped.set(rule.path, rules);
  }
  return Array.from(grouped, ([path, rules]) => {
    if (!paths.has(path)) return { path, status: "deleted", editable: analyticsPath(path) };
    const source = git(["show", `${upstream}:${path}`], cwd);
    try {
      transform(source, rules);
      return { path, status: "applies", editable: analyticsPath(path) };
    } catch (error) {
      return { path, status: "stale", editable: analyticsPath(path), error: error.message };
    }
  });
}
