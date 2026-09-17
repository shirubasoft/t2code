import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import { vi } from "vite-plus/test";
import * as ServerConfig from "../config.ts";
import * as ResourceAttribution from "../resourceTelemetry/ResourceAttribution.ts";
import { ObservabilityLive } from "./Layers/Observability.ts";

it.effect("keeps server traces local with both external exporters configured", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const observability = ObservabilityLive.pipe(
      Layer.provide(
        ServerConfig.layer({
          ...config,
          otlpTracesUrl: "https://collector.invalid/v1/traces",
          otlpMetricsUrl: "https://collector.invalid/v1/metrics",
        }),
      ),
      Layer.provide(ResourceAttribution.layer),
      Layer.provide(
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn))),
      ),
    );
    yield* Effect.scoped(
      Effect.void.pipe(
        Effect.withSpan("enterprise-source", { attributes: { code: "company secret" } }),
        Effect.provide(observability),
      ),
    );
    expect(fetchFn).not.toHaveBeenCalled();
    expect(yield* fs.readFileString(config.serverTracePath)).toContain("company secret");
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t2-observability-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
