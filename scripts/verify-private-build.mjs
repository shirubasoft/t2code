import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const directory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const codeExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".html", ".css"]);
const forbidden = [
  /(?:@sentry\/|posthog(?:-js|-node)?["']|@segment\/analytics|mixpanel-browser|amplitude-js|@amplitude\/analytics|@vercel\/analytics|@clerk\/)/i,
  /(?:us|eu)\.i\.posthog\.com|(?:ingest\.)?sentry\.io|api\.segment\.io|api\.axiom\.co|o[0-9]+\.ingest\./i,
  /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["'`]react-grab(?:\/core)?["'`]/,
  /\b(?:www\.)?react-grab\.com\/api\/version\b/i,
  /x-user-staging-id|\.updaterId\b/i,
  /(?:OtlpTracer|OtlpMetrics|OtlpLogger|OTLPTraceExporter|OTLPMetricExporter)\s*\./,
];
// Any file that can open a connection, delegate execution, configure a client,
// or introduce an endpoint needs an exact reviewed digest. The migration agent
// cannot edit this baseline. Formatting-only edits are conservative failures.
const capability =
  /effect\/unstable\/(?:http|socket|process)|node:|\brequire\s*\(|\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|HttpClient|FetchHttpClient|NodeHttpClient|httpClient|https|createConnection|connectTls|ProcessRunner|ChildProcess|spawn|execFile|execSync|shell|openExternal|loadURL|webRequest|autoUpdater|UserNetworkAccess)\b|(?:https?|wss?):\/\/|node:(?:http|https|net|tls|dns|dgram|child_process)|\.wasm\b|\beval\s*\(|\bnew\s+Function\b|\bimport\s*\(/;
const testFile =
  /(?:^|\/)(?:__tests__|__fixtures__|test-utils|fixtures|integration)(?:\/|$)|\.(?:test|spec|stories|integration)\.[^.]+$/;
const digest = (text) => NodeCrypto.createHash("sha256").update(text).digest("hex");

function walk(root) {
  const files = [];
  for (const entry of NodeFS.readdirSync(root, { withFileTypes: true })) {
    const path = NodePath.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink cannot be audited: ${path}`);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export function fileDigest(path, bytes) {
  if (path.endsWith("package.json")) {
    const manifest = JSON.parse(bytes.toString());
    delete manifest.version;
    return digest(JSON.stringify(manifest));
  }
  return digest(bytes);
}

function sourceFiles(source) {
  return NodeChildProcess.execFileSync(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      source,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean)
    .filter((path) => !path.startsWith(".repos/"));
}

export function inventory(source, paths = sourceFiles(source)) {
  const capabilities = {};
  const dependencies = {};
  const violations = [];
  for (const path of paths) {
    if (path.startsWith(".claude/") || path.startsWith(".agents/")) continue;
    const file = NodePath.join(source, path);
    let stat;
    try {
      stat = NodeFS.lstatSync(file);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      violations.push(`${path}: symlinks cannot enter the audited source`);
      continue;
    }
    if (!stat.isFile()) continue;
    if (path === "scripts/private-build-policy.json") continue;
    const manifest = path.endsWith("package.json");
    const buildInput =
      path.startsWith("scripts/") ||
      path.startsWith("patches/") ||
      path.startsWith("native/") ||
      /^([^/]+\.(?:json|ya?ml|[cm]?js|ts)|\.gitmodules|\.npmrc|\.pnpmfile\.[cm]?js)$/.test(path) ||
      (/^(?:apps|packages)\//.test(path) &&
        !path.includes("/src/") &&
        /\.(?:[cm]?[jt]sx?|json|ya?ml|rs|toml|lock|sh|ps1)$/.test(path));
    const runtime = /^(?:apps|packages)\//.test(path) && codeExtensions.has(NodePath.extname(file));
    if (manifest) {
      const value = JSON.parse(NodeFS.readFileSync(file, "utf8"));
      dependencies[path] = Object.keys(value.dependencies ?? {}).sort();
      if (/^(?:apps|packages)\//.test(path))
        for (const dependency of dependencies[path]) {
          if (forbidden.some((pattern) => pattern.test(`${dependency}"`)))
            violations.push(`${path}: prohibited dependency ${dependency}`);
        }
    }
    if (testFile.test(path) || (!runtime && !buildInput)) continue;
    const bytes = NodeFS.readFileSync(file);
    const text = bytes.toString();
    if (runtime && path.includes("/src/"))
      for (const pattern of forbidden) {
        if (pattern.test(text))
          violations.push(`${path}: prohibited telemetry or hosted authentication code ${pattern}`);
      }
    if (
      runtime &&
      /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["'][^"']*\.(?:test|spec|stories|integration)(?:\.[^"']*)?["']|(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["'][^"']*\/(?:__tests__|__fixtures__|test-utils|fixtures|integration)\/[^"']*["']/.test(
        text,
      )
    )
      violations.push(`${path}: runtime imports test code`);
    if (buildInput || (runtime && capability.test(text)))
      capabilities[path] = fileDigest(path, bytes);
  }
  return { capabilities, dependencies, violations };
}

export function verifySource(source, policy, paths) {
  const actual = inventory(source, paths);
  const violations = [...actual.violations];
  for (const [path, sha] of Object.entries(actual.capabilities)) {
    if (policy.capabilities[path] !== sha)
      violations.push(`${path}: network/process capability changed without accepted policy review`);
  }
  for (const [path, sha] of Object.entries(policy.boundaries)) {
    try {
      if (fileDigest(path, NodeFS.readFileSync(NodePath.join(source, path))) !== sha)
        violations.push(`${path}: privacy boundary changed`);
    } catch {
      violations.push(`${path}: required privacy boundary missing`);
    }
  }
  for (const [path, dependencies] of Object.entries(actual.dependencies)) {
    for (const dependency of dependencies) {
      if (!policy.dependencies[path]?.includes(dependency))
        violations.push(`${path}: unreviewed runtime dependency ${dependency}`);
    }
  }
  return violations;
}

export function verifyArtifacts(root) {
  const violations = [];
  let files = 0;
  for (const file of walk(root)) {
    if (!codeExtensions.has(NodePath.extname(file))) continue;
    files++;
    const text = NodeFS.readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      if (pattern.test(text))
        violations.push(`${file}: prohibited code in release bundle ${pattern}`);
    }
  }
  if (!files) violations.push(`${root}: no compiled code found to audit`);
  return violations;
}

export function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!["--source", "--artifacts"].includes(flag) || !args[index + 1])
      throw new Error(
        "Usage: node scripts/verify-private-build.mjs --source PATH [--artifacts PATH]",
      );
    options[flag] = NodePath.resolve(args[index + 1]);
  }
  if (!options["--source"]) throw new Error("--source is required");
  // Resolve policy beside this trusted script, never from the candidate tree.
  const policy = JSON.parse(
    NodeFS.readFileSync(NodePath.join(directory, "private-build-policy.json"), "utf8"),
  );
  const violations = verifySource(options["--source"], policy);
  if (options["--artifacts"]) violations.push(...verifyArtifacts(options["--artifacts"]));
  if (violations.length) throw new Error(`Privacy checks failed:\n${violations.join("\n")}`);
  console.log(
    "Privacy policy passed: reviewed network capabilities, dependencies, and local boundaries.",
  );
}

if (
  process.argv[1] &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
)
  main(process.argv.slice(2));
