import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    /** Record an anonymous event for best-effort buffered delivery. */
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;

    /** Flush all currently queued telemetry events. */
    readonly flush: Effect.Effect<void>;
  }
>()("t3/telemetry/AnalyticsService") {
  /** No-op layer for callers that intentionally disable telemetry. */
  static readonly layerTest = Layer.succeed(
    AnalyticsService,
    AnalyticsService.of({
      record: () => Effect.void,
      flush: Effect.void,
    }),
  );
}

/**
 * Preserve the upstream service contract while compiling analytics out of the
 * distribution. Keeping this boundary stable minimizes conflicts when
 * rebasing new upstream call sites.
 */
export const make = Effect.succeed(
  AnalyticsService.of({
    record: () => Effect.void,
    flush: Effect.void,
  }),
);

export const layer = AnalyticsService.layerTest;
export const layerTest = AnalyticsService.layerTest;
