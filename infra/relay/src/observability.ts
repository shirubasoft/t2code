import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Tracer from "effect/Tracer";

export const withSpanAttributes =
  (attributes: Record<string, unknown>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.annotateCurrentSpan(attributes).pipe(
      Effect.andThen(effect.pipe(Effect.annotateSpans(attributes))),
    );

export const relayTraceLayerDisabled = Layer.succeed(
  Tracer.Tracer,
  Tracer.make({ span: (options) => new Tracer.NativeSpan(options) }),
);

export const makeRelayTraceLayer = (_input: {
  readonly tracesEndpoint: string;
  readonly tracesDatasetName: string;
  readonly ingestToken: Redacted.Redacted<string>;
}) => relayTraceLayerDisabled;
