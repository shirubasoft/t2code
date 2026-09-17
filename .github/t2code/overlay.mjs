import * as NodeChildProcess from "node:child_process";
const { execFileSync } = NodeChildProcess;
import * as NodeFS from "node:fs";
const { readFileSync, writeFileSync, mkdirSync, lstatSync } = NodeFS;
import * as NodePath from "node:path";
const { resolve, dirname } = NodePath;
import * as NodeURL from "node:url";
const { fileURLToPath } = NodeURL;

export const controlRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export function git(args, cwd = process.cwd()) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
export function assertSha(value) {
  if (!/^[a-f0-9]{40}$/.test(value ?? "")) throw new Error("Expected a complete commit SHA");
  return value;
}
export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
function safePath(path) {
  if (path === ".gitmodules") return path;
  if (!/^(apps|packages|scripts)\/[A-Za-z0-9_./-]+$/.test(path) || path.split("/").includes("..")) {
    throw new Error(`Invalid overlay path: ${path}`);
  }
  return path;
}
export function transform(source, rules) {
  let result = source;
  for (const { before, after } of rules) {
    if (typeof before !== "string" || !before || typeof after !== "string" || before === after) {
      throw new Error("Each patch must have distinct, nonempty before and after text");
    }
    if (result.split(before).length !== 2)
      throw new Error(`Patch anchor must occur once: ${before.slice(0, 120)}`);
    result = result.replace(before, () => after);
  }
  return result;
}
export function expectedFiles(root = process.cwd(), control = controlRoot) {
  const state = readJson(resolve(root, ".github/t2code/upstream.json"));
  const upstream = assertSha(state.commit);
  if (state.repository !== "pingdotgg/t3code") throw new Error("Unexpected upstream repository");
  const overlay = readJson(resolve(root, ".github/t2code/overlay.json"));
  if (!Array.isArray(overlay.replacements) || !Array.isArray(overlay.files))
    throw new Error("Invalid overlay");
  const grouped = new Map();
  for (const rule of overlay.replacements) {
    const path = safePath(rule.path);
    if (!grouped.has(path)) grouped.set(path, []);
    grouped.get(path).push(rule);
  }
  const files = new Map();
  for (const [path, rules] of grouped) {
    files.set(path, transform(git(["show", `${upstream}:${path}`], root), rules));
  }
  for (const path of overlay.files) {
    safePath(path);
    if (files.has(path)) throw new Error(`Duplicate overlay file: ${path}`);
    files.set(path, readFileSync(resolve(control, path), "utf8"));
  }
  return { upstream, files };
}
export function apply(root = process.cwd(), control = controlRoot) {
  const { files } = expectedFiles(root, control);
  for (const [path, content] of files) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), content);
  }
  git(["apply", resolve(control, ".github/t2code/release-manifest.patch")], root);
}
export function verify(root = process.cwd(), control = controlRoot) {
  const { upstream, files } = expectedFiles(root, control);
  for (const [path, content] of files) {
    if (
      !lstatSync(resolve(root, path)).isFile() ||
      readFileSync(resolve(root, path), "utf8") !== content
    ) {
      throw new Error(`Overlay differs from its declared patch: ${path}`);
    }
  }
  const changes = git(["diff", "--name-only", upstream, "--", ".", ":!.github"], root)
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const path of changes) {
    if (!files.has(path) && path !== "scripts/lib/update-manifest.ts")
      throw new Error(`Unrelated upstream change: ${path}`);
  }
  git(
    ["apply", "--reverse", "--check", resolve(control, ".github/t2code/release-manifest.patch")],
    root,
  );
  console.log(`Verified minimal overlay on upstream ${upstream}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[3] ?? ".");
  if (process.argv[2] === "apply") apply(root);
  else if (process.argv[2] === "verify") verify(root);
  else throw new Error("Expected apply or verify");
}
