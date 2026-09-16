import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

import {
  layer,
  rpcAllowsNetwork,
  UserNetworkAccess,
  ProviderNetworkOrigins,
} from "./networkPolicy.ts";

describe("local edition network transport", () => {
  it.effect("keeps local HTTP spans without sending trace headers to a configured harness", () =>
    Effect.gen(function* () {
      const spans: Tracer.NativeSpan[] = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const requests: Request[] = [];
      const response = yield* HttpClient.get("https://harness.example/api/usage", {
        headers: { authorization: "Bearer harness-token" },
      }).pipe(
        Effect.provide(layer),
        Effect.provideService(ProviderNetworkOrigins, ["https://harness.example"]),
        Effect.provideService(HttpClient.TracerPropagationEnabled, true),
        Effect.provideService(FetchHttpClient.Fetch, (input, init) => {
          requests.push(new Request(input, init));
          return Promise.resolve(new Response("local diagnostics preserved"));
        }),
        Effect.withSpan("provider.usage"),
        Effect.withTracer(tracer),
      );
      expect(yield* response.text).toBe("local diagnostics preserved");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers.get("authorization")).toBe("Bearer harness-token");
      for (const header of ["b3", "traceparent", "tracestate"]) {
        expect(requests[0]?.headers.has(header)).toBe(false);
      }
      expect(spans.some((span) => span.name === "http.client GET")).toBe(true);
      expect(spans.some((span) => span.name === "provider.usage")).toBe(true);
    }),
  );

  it.effect("rejects background external traffic before fetch runs", () =>
    Effect.gen(function* () {
      let calls = 0;
      const result = yield* HttpClient.get("https://example.com/collect").pipe(
        Effect.provide(layer),
        Effect.provideService(FetchHttpClient.Fetch, () => {
          calls++;
          return Promise.resolve(new Response());
        }),
        Effect.result,
      );
      expect(result._tag).toBe("Failure");
      expect(calls).toBe(0);
    }),
  );

  it.effect("rechecks each redirect from a local endpoint", () =>
    Effect.gen(function* () {
      const urls: string[] = [];
      const result = yield* HttpClient.get("http://127.0.0.1:3773/redirect").pipe(
        Effect.provide(layer),
        Effect.provideService(FetchHttpClient.Fetch, (url, init) => {
          urls.push(String(url));
          expect(init?.redirect).toBe("manual");
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: "https://example.com/collect" },
            }),
          );
        }),
        Effect.result,
      );
      expect(result._tag).toBe("Failure");
      expect(urls).toEqual(["http://127.0.0.1:3773/redirect"]);
    }),
  );

  it.effect("allows an explicit update with redirects without granting later requests", () =>
    Effect.gen(function* () {
      const urls: string[] = [];
      yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* client
          .get("https://github.com/shirubasoft/t2code/releases/latest")
          .pipe(Effect.provideService(UserNetworkAccess, true));
        expect(response.status).toBe(200);
        const blocked = yield* client.get("https://example.com/later").pipe(Effect.result);
        expect(blocked._tag).toBe("Failure");
      }).pipe(
        Effect.provide(layer),
        Effect.provideService(FetchHttpClient.Fetch, (url, init) => {
          urls.push(String(url));
          expect(init?.redirect).toBe("manual");
          for (const header of ["b3", "traceparent", "tracestate"]) {
            expect(new Headers(init?.headers).has(header)).toBe(false);
          }
          return Promise.resolve(
            urls.length === 1
              ? new Response(null, {
                  status: 302,
                  headers: { location: "https://release-assets.githubusercontent.com/asset" },
                })
              : new Response("download"),
          );
        }),
      );
      expect(urls).toHaveLength(2);
    }),
  );

  it.effect("allows only the configured harness origin without granting later requests", () =>
    Effect.gen(function* () {
      const urls: string[] = [];
      yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const granted = yield* client
          .get("https://harness.example:8443/api/usage")
          .pipe(Effect.provideService(ProviderNetworkOrigins, ["https://harness.example:8443"]));
        expect(granted.status).toBe(200);
        for (const url of [
          "https://other.example/collect",
          "https://harness.example/api/usage",
          "https://harness.example:8443.evil.test/collect",
        ]) {
          const blocked = yield* client
            .get(url)
            .pipe(
              Effect.provideService(ProviderNetworkOrigins, ["https://harness.example:8443"]),
              Effect.result,
            );
          expect(blocked._tag).toBe("Failure");
        }
        expect(
          (yield* client.get("https://harness.example:8443/later").pipe(Effect.result))._tag,
        ).toBe("Failure");
      }).pipe(
        Effect.provide(layer),
        Effect.provideService(FetchHttpClient.Fetch, (url) => {
          urls.push(String(url));
          return Promise.resolve(new Response());
        }),
      );
      expect(urls).toEqual(["https://harness.example:8443/api/usage"]);
    }),
  );

  it.effect("rejects a configured harness redirect to an unlisted origin", () =>
    Effect.gen(function* () {
      const urls: string[] = [];
      const result = yield* HttpClient.get("https://harness.example/redirect").pipe(
        Effect.provide(layer),
        Effect.provideService(ProviderNetworkOrigins, ["https://harness.example"]),
        Effect.provideService(FetchHttpClient.Fetch, (url, init) => {
          urls.push(String(url));
          expect(init?.redirect).toBe("manual");
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: "https://collector.example/collect" },
            }),
          );
        }),
        Effect.result,
      );
      expect(result._tag).toBe("Failure");
      expect(urls).toEqual(["https://harness.example/redirect"]);
    }),
  );

  it("grants only declared user actions", () => {
    expect(rpcAllowsNetwork("server.updateServer")).toBe(true);
    expect(rpcAllowsNetwork("vcs.pull")).toBe(true);
    expect(rpcAllowsNetwork("server.getConfig")).toBe(false);
    expect(rpcAllowsNetwork("provider.refresh")).toBe(false);
    expect(rpcAllowsNetwork("future.telemetry")).toBe(false);
  });
});
