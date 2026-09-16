import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeRelayTraceLayer, withSpanAttributes } from "./observability.ts";

it.effect("runs relay instrumentation without exporter services", () =>
  Effect.succeed("completed").pipe(
    withSpanAttributes({ operation: "test" }),
    Effect.withSpan("relay.test"),
    Effect.provide(makeRelayTraceLayer()),
    Effect.tap((result) => Effect.sync(() => assert.equal(result, "completed"))),
  ),
);
