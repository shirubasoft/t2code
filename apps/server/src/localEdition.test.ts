import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId, UsageDay } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient } from "effect/unstable/http";
import { vi } from "vite-plus/test";

import * as ServerConfig from "./config.ts";
import { ObservabilityLive } from "./observability/Layers/Observability.ts";
import * as ModelManifest from "./provider/ModelManifest.ts";
import * as AgentAwarenessRelay from "./relay/AgentAwarenessRelay.ts";
import * as ResourceAttribution from "./resourceTelemetry/ResourceAttribution.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as UsageService from "./usage/UsageService.ts";

it.layer(NodeServices.layer)("local edition", (it) => {
  it.effect(
    "keeps traces, resource counters, model metadata, and token usage usable without delivery",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const attribution = yield* ResourceAttribution.ResourceAttribution;
        const claudeHome = path.join(config.baseDir, "claude");
        const transcriptDir = path.join(claudeHome, "projects", "local-project");
        yield* fs.makeDirectory(transcriptDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(transcriptDir, "session.jsonl"),
          '{"type":"assistant","timestamp":"2026-08-01T10:00:00Z","requestId":"request-1","sessionId":"session-1","message":{"id":"message-1","model":"local-test-model","usage":{"input_tokens":10,"output_tokens":5}}}\n',
        );
        const requests: string[] = [];
        const transport = HttpClient.make((request) => {
          requests.push(request.url);
          return Effect.die(
            new Error("The local diagnostics smoke test attempted an HTTP request."),
          );
        });
        const fetchSpy = yield* Effect.acquireRelease(
          Effect.sync(() =>
            vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
              requests.push("global fetch");
              throw new Error("The local diagnostics smoke test attempted a fetch.");
            }),
          ),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        const localServices = Layer.mergeAll(
          AnalyticsService.layer,
          AgentAwarenessRelay.layer,
          ModelManifest.layer,
          UsageService.layer,
          ObservabilityLive,
        ).pipe(
          Layer.provide(
            ServerSettings.layerTest({
              providers: {
                claudeAgent: { homePath: claudeHome },
                codex: { homePath: path.join(config.baseDir, "codex") },
              },
              usagePriceOverrides: {
                "local-test-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
              },
            }),
          ),
          Layer.provide(
            Layer.succeed(HostProcessEnvironment, { GROK_HOME: path.join(config.baseDir, "grok") }),
          ),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, transport)),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                T3CODE_TELEMETRY_ENABLED: true,
                T3CODE_POSTHOG_HOST: "https://collector.example.test",
                T3CODE_OTLP_TRACES_URL: "https://collector.example.test/v1/traces",
                T3CODE_OTLP_METRICS_URL: "https://collector.example.test/v1/metrics",
              }),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const analytics = yield* AnalyticsService.AnalyticsService;
          yield* analytics.record("local.startup", { privateData: "must stay local" });
          yield* analytics.flush;
          const relay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
          yield* relay.start();
          yield* relay.publishThread(ThreadId.make("local-thread"));
          const manifest = yield* ModelManifest.ModelManifest;
          assert.strictEqual(yield* manifest.refresh, ModelManifest.BUNDLED_MODEL_MANIFEST);
          yield* manifest.refreshInBackground;
          const usage = yield* UsageService.UsageService;
          const summary = yield* usage.readSummary({
            timeZone: "UTC",
            sinceDay: UsageDay.make("2026-08-01"),
            untilDay: UsageDay.make("2026-08-01"),
          });
          assert.equal(summary.buckets[0]?.totals.outputTokens, 5);
          assert.closeTo(summary.buckets[0]?.costUsd ?? -1, 0.00006, 1e-12);
          assert.isAbove((yield* usage.refreshRates).knownModels, 0);
          yield* attribution.record({
            component: "local-test",
            operation: "read",
            logicalReadBytes: 64,
          });
          yield* Effect.void.pipe(Effect.withSpan("local-edition.diagnostics", { level: "Info" }));
        }).pipe(Effect.provide(localServices));

        // Scope finalization flushes the trace file before assertions, without a timer.
        assert.include(
          yield* fs.readFileString(config.serverTracePath),
          "local-edition.diagnostics",
        );
        const snapshot = yield* attribution.snapshot;
        assert.equal(
          snapshot.entries.find((entry) => entry.component === "local-test")?.logicalReadBytes,
          64,
        );
        assert.isAbove(
          snapshot.entries.find((entry) => entry.component === "server-trace")?.logicalWriteBytes ??
            0,
          0,
        );
        assert.deepEqual(requests, []);
        assert.equal(fetchSpy.mock.calls.length, 0);
        assert.notInclude((yield* fs.readDirectory(config.stateDir)).join("\n"), "anonymous-id");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerConfig.layerTest(process.cwd(), { prefix: "t2-local-edition-" }),
            ResourceAttribution.layer,
          ),
        ),
      ),
  );
});
