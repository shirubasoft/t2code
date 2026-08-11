import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";

import { ServerLoggerLive } from "../../serverLogger.ts";
import * as BrowserTraceCollector from "../BrowserTraceCollector.ts";

/**
 * Keep ordinary application logging while disabling trace collection, local
 * trace files, metrics, and every remote observability exporter.
 */
export const ObservabilityLive = Layer.mergeAll(
  ServerLoggerLive,
  Layer.succeed(Tracer.MinimumTraceLevel, "None"),
  Layer.succeed(References.TracerTimingEnabled, false),
  BrowserTraceCollector.layerDisabled,
);
