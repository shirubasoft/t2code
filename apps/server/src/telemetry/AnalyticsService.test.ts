import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import { getTelemetryIdentity } from "./Identify.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

interface RecordedBatchRequest {
  readonly path: string;
  readonly body: {
    readonly batch?: ReadonlyArray<{
      readonly event?: string;
      readonly properties?: {
        readonly index?: number;
        readonly clientType?: string;
        readonly serverOs?: string;
        readonly serverArch?: string;
        readonly serverAppVersion?: string;
        readonly serverMode?: string;
        readonly t3CodeVersion?: string;
      };
    }>;
  } | null;
}

const SentBatch = Schema.fromJsonString(
  Schema.Struct({
    batch: Schema.Array(
      Schema.Struct({
        uuid: Schema.String,
        event: Schema.String,
        distinct_id: Schema.String,
        properties: Schema.Struct({
          telemetryChannel: Schema.String,
          installId: Schema.optionalKey(Schema.String),
          ownerSource: Schema.optionalKey(Schema.String),
          observedBy: Schema.optionalKey(Schema.String),
        }),
      }),
    ),
  }),
);
const decodeSentBatch = Schema.decodeEffect(SentBatch);
type SentEvent = (typeof SentBatch.Type)["batch"][number];
type Respond = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;

const respondWithStatus =
  (status: number): Respond =>
  (request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status })));

/**
 * Answers 503 for `minutes` after the first send, then 204. `answers` holds each
 * answer with its time in ms after the first send (the test clock runs on across tests).
 */
const failingFor = (minutes: number) => {
  const answers: Array<{ readonly at: number; readonly status: number }> = [];
  let firstSend: number | undefined;
  const respond: Respond = (request) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) => {
      firstSend ??= now;
      const at = now - firstSend;
      const status = at < minutes * 60_000 ? 503 : 204;
      answers.push({ at, status });
      return respondWithStatus(status)(request);
    });
  return { respond, answers };
};

const recordTwentyEvents = Effect.gen(function* () {
  const analytics = yield* AnalyticsService.AnalyticsService;
  for (let index = 0; index < 20; index += 1) {
    yield* analytics.record("test.retry", { index });
  }
});

/**
 * Runs `record` (20 events by default), then lets `minutes` of background
 * flushes run against a client that answers every send with `respond`.
 * Returns the sent batches.
 */
const sendFor = (
  minutes: number,
  respond: Respond,
  record: Effect.Effect<
    void,
    never,
    AnalyticsService.AnalyticsService | Effect.Services<typeof getTelemetryIdentity>
  > = recordTwentyEvents,
) =>
  Effect.gen(function* () {
    const batches: Array<ReadonlyArray<SentEvent>> = [];
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        if (request.body._tag === "Uint8Array") {
          const body = yield* decodeSentBatch(new TextDecoder().decode(request.body.body)).pipe(
            Effect.orDie,
          );
          batches.push(body.batch);
        }
        return yield* respond(request);
      }),
    );
    const runtimeLayer = AnalyticsService.layer.pipe(
      Layer.provideMerge(
        ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-telemetry-retry-" }),
      ),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            T3CODE_TELEMETRY_ENABLED: true,
            T3CODE_POSTHOG_KEY: "phc_test_key",
            T3CODE_POSTHOG_HOST: "http://localhost",
          }),
        ),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcess.Platform, "win32"),
          Layer.succeed(HostProcess.Architecture, "x64"),
          Layer.succeed(HttpClient.HttpClient, client),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      yield* record;
      for (let second = 0; second < minutes * 60; second += 1) {
        yield* TestClock.adjust("1 second");
      }
    }).pipe(Effect.provide(runtimeLayer));
    return batches;
  });

it.layer(NodeServices.layer)("AnalyticsService test", (it) => {
  it.effect("does not export client or server ownership reports", () =>
    Effect.gen(function* () {
      const batches = yield* sendFor(
        10,
        respondWithStatus(204),
        Effect.gen(function* () {
          const analytics = yield* AnalyticsService.AnalyticsService;
          yield* analytics.recordOwners(
            Array.from({ length: 1_001 }, (_, index) => ({
              source: "device" as const,
              ownerId: index.toString(16).padStart(64, "0"),
            })),
            "client",
          );
          // The event buffer also holds 1,000, so send the client events first.
          yield* analytics.flush;
          yield* analytics.recordOwners([{ source: "connect", ownerId: "a".repeat(64) }], "server");
        }),
      );
      assert.deepEqual(batches, []);
    }),
  );

  it.effect("never sends through an outage or after recovery", () =>
    Effect.gen(function* () {
      const ingest = failingFor(20);
      const batches = yield* sendFor(40, ingest.respond);
      const statuses = ingest.answers.map(({ status }) => status);
      assert.deepEqual(statuses, []);
      assert.deepEqual(batches, []);
    }),
  );

  it.effect("never sends while a collector remains unavailable", () =>
    Effect.gen(function* () {
      const ingest = failingFor(Infinity);
      yield* sendFor(60, ingest.respond);
      assert.deepEqual(ingest.answers, []);
    }),
  );

  it.effect("never contacts a rejecting collector", () =>
    Effect.gen(function* () {
      const batches = yield* sendFor(10, respondWithStatus(400));
      assert.deepEqual(batches, []);
    }),
  );

  it.effect("does not export buffered events even when telemetry is configured", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const layerServerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-telemetry-base-",
      });

      const layerTelemetry = AnalyticsService.layer.pipe(Layer.provideMerge(layerServerConfig));
      const layerConfig = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          T3CODE_TELEMETRY_ENABLED: true,
          T3CODE_POSTHOG_KEY: "phc_test_key",
          T3CODE_POSTHOG_HOST: "http://localhost",
          T3CODE_TELEMETRY_FLUSH_BATCH_SIZE: 20,
        }),
      );
      const layerBatchServer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.method !== "POST") {
            return HttpServerResponse.empty({ status: 404 });
          }

          const payload = yield* request.json.pipe(
            Effect.map((body) => body as RecordedBatchRequest["body"]),
            Effect.orElseSucceed(() => null),
          );

          capturedRequests.push({ path: request.url, body: payload });

          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const layerRuntime = layerTelemetry.pipe(
        Layer.provide(layerConfig),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcess.Platform, "linux"),
            Layer.succeed(HostProcess.Architecture, "arm64"),
          ),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(layerBatchServer).pipe(Effect.forkScoped);
        const { distinctId } = yield* getTelemetryIdentity;
        assert.equal(distinctId !== null, true);
        const analytics = yield* AnalyticsService.AnalyticsService;

        for (let index = 0; index < 45; index += 1) {
          yield* analytics.record("test.flush.drain", { index, sourceCode: "company secret" });
        }

        yield* analytics.flush;
      }).pipe(Effect.provide(layerRuntime));

      assert.deepEqual(capturedRequests, []);
    }),
  );

  it.effect("does not send batch requests when telemetry is disabled", () =>
    Effect.gen(function* () {
      const capturedPaths: Array<string> = [];
      const layerServerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-telemetry-disabled-",
      });
      const layerTelemetry = AnalyticsService.layer.pipe(Layer.provideMerge(layerServerConfig));
      const layerConfig = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          T3CODE_TELEMETRY_ENABLED: false,
          T3CODE_POSTHOG_KEY: "phc_test_key",
          T3CODE_POSTHOG_HOST: "http://localhost",
        }),
      );
      const layerBatchServer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          capturedPaths.push(request.url);
          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const layerRuntime = layerTelemetry.pipe(
        Layer.provide(layerConfig),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcess.Platform, "linux"),
            Layer.succeed(HostProcess.Architecture, "arm64"),
          ),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(layerBatchServer).pipe(Effect.forkScoped);
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("test.disabled", { index: 1 });
        yield* analytics.flush;
      }).pipe(Effect.provide(layerRuntime));

      assert.deepEqual(capturedPaths, []);
    }),
  );
});
