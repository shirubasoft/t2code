import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { ResourceTelemetryProcess } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ResourceTelemetry from "./ResourceTelemetry.ts";
import { groupProcesses, layer } from "./ProcessGroupMetrics.ts";

it.effect("does not sample process groups for a configured external metrics collector", () => {
  let samples = 0;
  return Effect.gen(function* () {
    yield* Layer.build(layer);
    yield* TestClock.adjust("2 minutes");
    assert.equal(samples, 0);
  }).pipe(
    Effect.provide(
      Layer.mock(ResourceTelemetry.ResourceTelemetry)({
        refresh: Effect.sync(() => {
          samples += 1;
        }).pipe(Effect.andThen(Effect.never)),
      }),
    ),
    Effect.updateService(ServerConfig.ServerConfig, (config) => ({
      ...config,
      otlpMetricsUrl: "https://collector.invalid/v1/metrics",
    })),
    Effect.provide(
      ServerConfig.layerTest(import.meta.dirname, { prefix: "t2-process-group-metrics-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  );
});

const process = (
  pid: number,
  ppid: number,
  name: string,
  category: ResourceTelemetryProcess["category"] = "server-child",
  command = name,
) =>
  ({
    identity: { pid, startTimeMs: 1 },
    ppid,
    name,
    command,
    category,
    residentBytes: pid * 1_000,
    cpuPercent: pid,
  }) as ResourceTelemetryProcess;

describe("groupProcesses", () => {
  it("sums each direct child of the server with its whole subtree", () => {
    const totals = groupProcesses([
      process(10, 1, "node", "server"),
      process(11, 10, "t3-resource-mon", "resource-monitor"),
      process(20, 10, "claude"),
      process(21, 20, "bash"),
      process(22, 21, "cargo"),
      process(30, 10, "codex"),
      process(40, 10, "zsh"),
      process(50, 10, "chrome-headless"),
      process(60, 10, "git", "server-child", "git checkout claude/fix"),
      process(70, 99, "orphan"),
      // An older Claude package runs as a script under node.
      process(
        80,
        10,
        "node",
        "server-child",
        "node /opt/node_modules/@anthropic-ai/claude-code/cli.js",
      ),
      process(90, 10, "node", "server-child", "node /srv/tools/report.js"),
    ]);

    assert.deepStrictEqual(Object.fromEntries(totals), {
      server: { residentBytes: 10_000, cpuPercent: 10, count: 1 },
      "resource-monitor": { residentBytes: 11_000, cpuPercent: 11, count: 1 },
      // The agent's shell and the build it ran belong to the agent, not the terminal group.
      claude: { residentBytes: 143_000, cpuPercent: 143, count: 4 },
      codex: { residentBytes: 30_000, cpuPercent: 30, count: 1 },
      terminal: { residentBytes: 40_000, cpuPercent: 40, count: 1 },
      browser: { residentBytes: 50_000, cpuPercent: 50, count: 1 },
      // `git` whose arguments mention claude, a parentless process, and a node script.
      other: { residentBytes: 220_000, cpuPercent: 220, count: 3 },
    });
  });
});
