// @effect-diagnostics nodeBuiltinImport:off - exercises the real native runner and local HTTP collector.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

it("keeps the authenticated cache hook usable without delivering diagnostic reports", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "task-cache-private-"));
  try {
    const hook = new URL("./runHook.ts", import.meta.url).href;
    const code = `
      import start from ${JSON.stringify(hook)};
      import * as fs from "node:fs";
      import * as path from "node:path";
      globalThis.fetch = async () => { throw new Error("Unexpected diagnostic request"); };
      const finish = start({ root: process.cwd() });
      if (!finish || finish.remoteCache !== "read-write") throw new Error("Cache hook unavailable");
      const version = path.join(process.cwd(), "node_modules/.vite/task-cache/v18");
      fs.mkdirSync(version, { recursive: true });
      fs.writeFileSync(path.join(version, "last-summary.json"), JSON.stringify({ tasks: [{
        package_name: "@team/server", task_name: "typecheck", result: { Spawned: {} }
      }] }));
      await finish();
      if (fs.existsSync(path.join(process.cwd(), ".cache/t3-task-cache/telemetry")))
        throw new Error("Unexpected diagnostic queue");
    `;
    await new Promise<void>((resolve, reject) => {
      const child = NodeChildProcess.spawn(process.execPath, ["--input-type=module", "-e", code], {
        cwd: root,
        env: {
          ...process.env,
          HOME: root,
          NODE_OPTIONS: "",
          GITHUB_ACTIONS: "true",
          T3_TASK_CACHE_TELEMETRY: "on",
          VP_REMOTE_CACHE: "read-write",
          VP_REMOTE_CACHE_URL: "https://alice:fixture-token@cache.invalid/projects/t3code",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.once("error", reject);
      child.once("close", (status) => (status === 0 ? resolve() : reject(new Error(output))));
    });
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("rejects invalid setup credentials before installing anything and never prints the token", async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "task-cache-setup-"));
  const token = "private-credential-that-must-not-appear-in-output";
  const server = NodeHttp.createServer((_request, response) => response.writeHead(401).end());
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP address");
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = NodeChildProcess.spawn(
        process.execPath,
        [NodePath.join(import.meta.dirname, "../scripts/install.ts"), "--non-interactive"],
        {
          env: {
            ...process.env,
            HOME: home,
            T3_CACHE_SETUP_URL: `http://127.0.0.1:${address.port}/projects/test`,
            T3_CACHE_SETUP_NAME: "maria",
            T3_CACHE_SETUP_TOKEN: token,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, output }));
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("Credential verification failed (401)");
    expect(result.output).not.toContain(token);
    expect(await NodeFSP.readdir(home)).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
});

it("does not start telemetry or create local state without cache credentials", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "task-cache-unconfigured-"));
  try {
    await NodeFSP.writeFile(
      NodePath.join(root, ".task-cache.json"),
      JSON.stringify({ endpoint: "https://cache.invalid/projects/test" }),
    );
    const hook = new URL("./runHook.ts", import.meta.url).href;
    const output = await new Promise<string>((resolve, reject) => {
      const child = NodeChildProcess.spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import start from ${JSON.stringify(hook)}; const finish = start({ root: process.cwd() }); if (finish !== undefined) process.exit(1);`,
        ],
        {
          cwd: root,
          env: { ...process.env, HOME: root, VP_REMOTE_CACHE_URL: "" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 ? resolve(output) : reject(new Error(output || `Exited ${code}`)),
      );
    });
    expect(output).toBe("");
    expect(await NodeFSP.readdir(root)).toEqual([".task-cache.json"]);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("installs without masking .profile and configures CI through bash", async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "task-cache-login-"));
  const probes: unknown[] = [];
  const server = NodeHttp.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    probes.push(JSON.parse(body));
    response.writeHead(204).end();
  });
  const run = (args: string[], env: NodeJS.ProcessEnv) =>
    new Promise<string>((resolve, reject) => {
      const child = NodeChildProcess.spawn(args[0]!, args.slice(1), {
        env: { ...process.env, ...env, HOME: home, NODE_OPTIONS: "" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => (code === 0 ? resolve(output) : reject(new Error(output))));
    });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP address");
    await NodeFSP.writeFile(NodePath.join(home, ".profile"), "export EXISTING_PROFILE=preserved\n");
    await NodeFSP.mkdir(NodePath.join(home, ".config/t3-task-cache"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(home, ".config/t3-task-cache/credentials.json"),
      "{partial",
    );
    await run(
      [
        process.execPath,
        NodePath.join(import.meta.dirname, "../scripts/install.ts"),
        "--non-interactive",
      ],
      {
        T3_CACHE_SETUP_URL: `http://127.0.0.1:${address.port}/projects/test`,
        T3_CACHE_SETUP_NAME: "maria",
        T3_CACHE_SETUP_TOKEN: "test-credential-for-isolated-http-server",
      },
    );
    expect(probes).toEqual([
      expect.objectContaining({
        recordedAt: 0,
        host: "",
        platform: "",
        arch: "",
        tasks: [],
      }),
    ]);
    expect(await NodeFSP.readdir(home)).not.toContain(".bash_profile");
    expect(await NodeFSP.readFile(NodePath.join(home, ".profile"), "utf8")).toContain(
      "EXISTING_PROFILE=preserved",
    );
    const githubEnv = NodePath.join(home, "github-env");
    await run([process.execPath, NodePath.join(import.meta.dirname, "../scripts/install-ci.ts")], {
      T3_TASK_CACHE_READ_TOKEN: "read-only-fixture-token-01234567890123456789",
      GITHUB_REPOSITORY: "pingdotgg/t3code",
      GITHUB_ACTIONS: "true",
      GITHUB_ENV: githubEnv,
      RUNNER_TEMP: home,
    });
    const values = await NodeFSP.readFile(githubEnv, "utf8");
    expect(values).not.toContain("\nNODE_OPTIONS=");
    const bashEnv = values
      .split("\n")
      .find((line) => line.startsWith("BASH_ENV="))
      ?.slice(9);
    const output = await run(["bash", "-c", 'printf "%s" "$NODE_OPTIONS"'], { BASH_ENV: bashEnv });
    expect(output).toContain("--import=file:");
    expect(output).toContain("/infra/task-cache/src/preload.mjs");
    await NodeFSP.rm(NodePath.join(home, ".local/share/t3-task-cache/preload.mjs"));
    const missing = await run(["bash", "-c", `node -e 'console.log("missing preload is safe")'`], {
      BASH_ENV: NodePath.join(home, ".config/t3-task-cache/env"),
    });
    expect(missing).toContain("missing preload is safe");

    await NodeFSP.writeFile(
      NodePath.join(home, ".bash_profile"),
      '. "$HOME/.config/t3-task-cache/env"\n',
    );
    await run(
      [
        process.execPath,
        NodePath.join(import.meta.dirname, "../scripts/install.ts"),
        "--uninstall",
      ],
      {},
    );
    expect(await NodeFSP.readdir(home)).not.toContain(".bash_profile");
    expect(await NodeFSP.readdir(NodePath.join(home, ".local/share/t3-task-cache"))).toEqual([
      "preload.mjs",
    ]);
    expect(await NodeFSP.readFile(NodePath.join(home, ".profile"), "utf8")).not.toContain(
      "t3-task-cache/env",
    );
    expect(await NodeFSP.readdir(NodePath.join(home, ".config/t3-task-cache"))).not.toContain(
      "credentials.json",
    );
    const remaining = await run(
      [
        process.execPath,
        "--import",
        NodePath.join(home, ".local/share/t3-task-cache/preload.mjs"),
        "-e",
        'console.log("node survives uninstall")',
      ],
      {},
    );
    expect(remaining).toContain("node survives uninstall");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
});

it("does not send an old endpoint's token after changing the URL interactively", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "task-cache-endpoint-"));
  const requests: string[] = [];
  const server = NodeHttp.createServer((request, response) => {
    requests.push(request.headers.authorization || "");
    response.writeHead(401).end();
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP address");
    const nested = NodePath.join(root, "nested");
    await NodeFSP.mkdir(nested);
    await NodeFSP.writeFile(
      NodePath.join(nested, "package.json"),
      JSON.stringify({ name: "nested", scripts: { build: 'node -e "console.log(8)"' } }),
    );
    await NodeFSP.writeFile(NodePath.join(nested, "pnpm-workspace.yaml"), "packages: []\n");
    const endpoint = `http://127.0.0.1:${address.port}/projects/test`;
    const scripts = NodePath.join(root, "infra/task-cache/scripts");
    await NodeFSP.mkdir(scripts, { recursive: true });
    await NodeFSP.mkdir(NodePath.join(root, "infra/task-cache/src"));
    await NodeFSP.writeFile(NodePath.join(root, "package.json"), '{"type":"module"}');
    await NodeFSP.writeFile(NodePath.join(root, ".task-cache.json"), JSON.stringify({ endpoint }));
    await NodeFSP.copyFile(
      NodePath.join(import.meta.dirname, "../scripts/install.ts"),
      NodePath.join(scripts, "install.ts"),
    );
    await NodeFSP.copyFile(
      NodePath.join(import.meta.dirname, "nativeHook.js"),
      NodePath.join(root, "infra/task-cache/src/nativeHook.js"),
    );
    await NodeFSP.mkdir(NodePath.join(root, ".config/t3-task-cache"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(root, ".config/t3-task-cache/credentials.json"),
      JSON.stringify({
        [endpoint]: { name: "maria", token: "different-saved-endpoint-credential" },
      }),
    );
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = NodeChildProcess.spawn(
        process.execPath,
        [NodePath.join(scripts, "install.ts")],
        {
          env: {
            ...process.env,
            HOME: root,
            NODE_OPTIONS: "",
            T3_CACHE_SETUP_URL: "https://old.example",
            T3_CACHE_SETUP_NAME: "maria",
            T3_CACHE_SETUP_TOKEN: "old-endpoint-token-must-not-be-forwarded",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let output = "";
      let sentUrl = false;
      let sentName = false;
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (!sentUrl && output.includes("Cache URL")) {
          sentUrl = true;
          child.stdin.write(endpoint + "\n");
        }
        if (!sentName && output.includes("Developer name")) {
          sentName = true;
          child.stdin.write("\n");
        }
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, output }));
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("Use T3_CACHE_SETUP_TOKEN");
    expect(requests).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("rejects non-loopback HTTP before transmitting a setup credential", async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "task-cache-http-"));
  try {
    const output = await new Promise<string>((resolve) => {
      NodeChildProcess.execFile(
        process.execPath,
        [NodePath.join(import.meta.dirname, "../scripts/install.ts"), "--non-interactive"],
        {
          env: {
            ...process.env,
            HOME: home,
            NODE_OPTIONS: "",
            T3_CACHE_SETUP_URL: "http://cache.invalid/projects/test",
            T3_CACHE_SETUP_NAME: "maria",
            T3_CACHE_SETUP_TOKEN: "test-credential-that-must-not-be-transmitted",
          },
        },
        (_error, stdout, stderr) => resolve(stdout + stderr),
      );
    });
    expect(output).toContain("Use an HTTPS cache endpoint");
    expect(await NodeFSP.readdir(home)).toEqual([]);
  } finally {
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
});
