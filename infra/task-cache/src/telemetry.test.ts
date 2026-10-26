// @effect-diagnostics nodeBuiltinImport:off - launcher integration with filesystem and fetch.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { flushTelemetry, observeSummaries, summarize } from "./telemetry.ts";

const task = (result: unknown) => ({
  package_name: "@team/server",
  task_name: "typecheck",
  command: "SECRET",
  cwd: "/private",
  result,
});

it("counts only confirmed hits, preserves their tier, and never transmits command text", () => {
  expect(
    summarize({
      tasks: [
        task({ CacheHit: { source: "Remote", saved_duration_ms: 1200 } }),
        task({ CacheHit: { source: "Local", saved_duration_ms: 500 } }),
        task({ RestoreFailed: {} }),
        task({ Spawned: {} }),
        task({ CacheHit: { saved_duration_ms: 999 } }),
        task({ CacheHit: { source: "Remote", saved_duration_ms: -1 } }),
      ],
    }),
  ).toEqual([
    { package: "@team/server", task: "typecheck", source: "remote", savedMs: 1200 },
    { package: "@team/server", task: "typecheck", source: "local", savedMs: 500 },
    { package: "@team/server", task: "typecheck", source: "failed", savedMs: 0 },
    { package: "@team/server", task: "typecheck", source: "executed", savedMs: 0 },
    { package: "@team/server", task: "typecheck", source: "unspecified", savedMs: 999 },
  ]);
});

it("keeps task summaries local even with valid credentials and telemetry enabled", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cache-observer-"));
  const home = NodePath.join(root, "home");
  const endpoint = "https://cache.example/projects/t3code";
  try {
    const stop = observeSummaries(root, endpoint, { T3_TASK_CACHE_HOST: "private-host" }, home);
    const version = NodePath.join(root, "node_modules/.vite/task-cache/v18");
    NodeFS.mkdirSync(version, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(version, "last-summary.json"),
      JSON.stringify({
        tasks: [task({ CacheHit: { source: "Remote", saved_duration_ms: 1200 } })],
      }),
    );
    stop();
    const queue = NodePath.join(home, ".cache/t3-task-cache/telemetry");
    expect(NodeFS.existsSync(queue)).toBe(false);
    const summaryFile = NodePath.join(version, "last-summary.json");
    const summary = NodeFS.readFileSync(summaryFile, "utf8");
    NodeFS.mkdirSync(NodePath.join(home, ".config/t3-task-cache"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(home, ".config/t3-task-cache/credentials.json"),
      JSON.stringify({ [endpoint]: { name: "alice", token: "secret-token" } }),
    );
    using request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    await flushTelemetry(home, { T3_TASK_CACHE_TELEMETRY: "on" });
    expect(request).not.toHaveBeenCalled();
    expect(NodeFS.existsSync(queue)).toBe(false);
    expect(NodeFS.readFileSync(summaryFile, "utf8")).toBe(summary);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("excludes tasks that explicitly disable caching from the hit-rate denominator", () => {
  expect(
    summarize({
      tasks: [
        task({ Spawned: { cache_status: "Disabled" } }),
        task({ Spawned: { cache_status: { Miss: "changed" } } }),
      ],
    }),
  ).toEqual([{ package: "@team/server", task: "typecheck", source: "executed", savedMs: 0 }]);
});
