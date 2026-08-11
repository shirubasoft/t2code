import type { TraceRecord, TraceSink } from "@t3tools/shared/observability";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class BrowserTraceCollector extends Context.Service<
  BrowserTraceCollector,
  {
    readonly record: (records: ReadonlyArray<TraceRecord>) => Effect.Effect<void>;
  }
>()("t3/observability/BrowserTraceCollector") {}

const disabledService = BrowserTraceCollector.of({ record: () => Effect.void });

export const make = (_sink: TraceSink): BrowserTraceCollector["Service"] => disabledService;

export const layer = (sink: TraceSink) => Layer.succeed(BrowserTraceCollector, make(sink));

export const layerDisabled = Layer.succeed(BrowserTraceCollector, disabledService);
