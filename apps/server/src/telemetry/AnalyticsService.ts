import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Compatibility service for upstream callers. Events are never retained or delivered. */
export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;
    readonly flush: Effect.Effect<void>;
  }
>()("t3/telemetry/AnalyticsService") {
  static readonly layerTest = Layer.succeed(
    AnalyticsService,
    AnalyticsService.of({ record: () => Effect.void, flush: Effect.void }),
  );
}

const make = Effect.succeed(AnalyticsService.of({ record: () => Effect.void, flush: Effect.void }));

export const layer = Layer.effect(AnalyticsService, make);
export const layerTest = AnalyticsService.layerTest;
