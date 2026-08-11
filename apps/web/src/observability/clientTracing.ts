import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";

export interface ClientTracingConfig {
  readonly exportIntervalMs?: number;
}

/**
 * Retain native spans for in-process correlation without installing an
 * exporter or sending traces outside the application.
 */
export const ClientTracingLive = Layer.succeed(
  Tracer.Tracer,
  Tracer.make({ span: (options) => new Tracer.NativeSpan(options) }),
);

/** Stable no-op boundary retained for upstream initialization call sites. */
export function configureClientTracing(_config: ClientTracingConfig = {}): Promise<void> {
  return Promise.resolve();
}

export function __resetClientTracingForTests(): Promise<void> {
  return Promise.resolve();
}
