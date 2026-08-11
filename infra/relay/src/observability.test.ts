import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as EnvironmentConnector from "./environments/EnvironmentConnector.ts";
import { makeRelayTraceLayer } from "./observability.ts";

it.effect("keeps relay error effects intact without exporting spans", () =>
  Effect.gen(function* () {
    const error = new EnvironmentConnector.EnvironmentConnectNotAuthorized({
      environmentId: "environment-1",
      operation: "connect",
      reason: "managed_endpoint_allocation_not_ready",
    });
    const exit = yield* Effect.fail(error).pipe(
      Effect.withSpan("relay.test.schema_error"),
      Effect.exit,
      Effect.provide(
        makeRelayTraceLayer({
          tracesEndpoint: "/v1/traces",
          tracesDatasetName: "relay-test-traces",
          ingestToken: Redacted.make("test-token"),
        }),
      ),
    );

    expect(exit._tag).toBe("Failure");
  }).pipe(Effect.provide(NodeHttpServer.layerTest), Effect.scoped),
);
