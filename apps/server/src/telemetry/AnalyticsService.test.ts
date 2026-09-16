import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import { vi } from "vite-plus/test";

import * as AnalyticsService from "./AnalyticsService.ts";

it.effect("cannot enable collection or delivery with legacy environment settings", () => {
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  const runtimeLayer = AnalyticsService.layer.pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          T3CODE_TELEMETRY_ENABLED: true,
          T3CODE_POSTHOG_HOST: "https://collector.example.test",
          T3CODE_POSTHOG_KEY: "test-key",
        }),
      ),
    ),
    Layer.provide(
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn))),
    ),
  );

  return Effect.gen(function* () {
    const analytics = yield* AnalyticsService.AnalyticsService;
    for (let index = 0; index < 45; index += 1) {
      yield* analytics.record("test.event", {
        get privateData() {
          throw new Error("Analytics must not inspect event data");
        },
      });
    }
    yield* analytics.flush;
  }).pipe(
    Effect.provide(runtimeLayer),
    Effect.andThen(Effect.sync(() => assert.equal(fetchFn.mock.calls.length, 0))),
  );
});

it.effect("starts without filesystem, identity, configuration, or HTTP services", () =>
  Effect.gen(function* () {
    const analytics = yield* AnalyticsService.AnalyticsService;
    yield* analytics.record("test.startup");
    yield* analytics.flush;
  }).pipe(Effect.provide(AnalyticsService.layer)),
);
