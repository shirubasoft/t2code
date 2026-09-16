import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { layer } from "./DesktopHttpClient.ts";

describe("desktop backend HTTP", () => {
  it.effect("rejects external requests before opening a connection", () =>
    Effect.gen(function* () {
      let calls = 0;
      const result = yield* HttpClient.get("https://example.com").pipe(
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
  it.effect("allows local authentication but rejects a redirect to an external host", () =>
    Effect.gen(function* () {
      const urls: string[] = [];
      const result = yield* HttpClient.get("http://127.0.0.1:3773/api/auth").pipe(
        Effect.provide(layer),
        Effect.provideService(FetchHttpClient.Fetch, (url, init) => {
          urls.push(String(url));
          expect(init?.redirect).toBe("manual");
          return Promise.resolve(
            new Response(null, { status: 302, headers: { location: "https://example.com" } }),
          );
        }),
        Effect.result,
      );
      expect(result._tag).toBe("Failure");
      expect(urls).toEqual(["http://127.0.0.1:3773/api/auth"]);
    }),
  );
});
