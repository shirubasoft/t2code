export interface ClientTracingConfig {
  readonly exportIntervalMs?: number;
}

/** Compatibility hook. This edition has no browser trace exporter. */
export function configureClientTracing(_config: ClientTracingConfig = {}): Promise<void> {
  return Promise.resolve();
}
