import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const withSpanAttributes =
  (attributes: Record<string, unknown>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.annotateCurrentSpan(attributes).pipe(
      Effect.andThen(effect.pipe(Effect.annotateSpans(attributes))),
    );

/** Compatibility layer with no collection, provisioning, or delivery. */
export const makeRelayTraceLayer = () => Layer.empty;
