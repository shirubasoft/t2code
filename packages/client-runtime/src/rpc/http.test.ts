import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientError } from "effect/unstable/http";
import { remoteHttpClientLayer } from "./http.ts";

describe("local client HTTP boundary", () => {
  it.effect("blocks external requests before the fetch implementation receives credentials", () =>
    Effect.gen(function* () {
      let calls = 0;
      const error = yield* HttpClient.get("https://external.test/api/auth/bootstrap", {
        headers: { authorization: "Bearer private" },
      }).pipe(
        Effect.provide(
          remoteHttpClientLayer(async () => {
            calls++;
            throw new Error("Unexpected network request");
          }),
        ),
        Effect.flip,
        Effect.scoped,
      );
      expect(HttpClientError.isHttpClientError(error)).toBe(true);
      expect(calls).toBe(0);
    }),
  );

  it.effect("allows loopback while disabling redirects to other hosts", () =>
    Effect.gen(function* () {
      const calls: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
      const response = yield* HttpClient.get("http://127.0.0.1:7777/api/environment").pipe(
        Effect.provide(
          remoteHttpClientLayer(async (input, init) => {
            calls.push({ url: String(input), redirect: init?.redirect });
            return Response.json({ local: true });
          }),
        ),
        Effect.scoped,
      );
      expect(response.status).toBe(200);
      expect(calls).toEqual([{ url: "http://127.0.0.1:7777/api/environment", redirect: "error" }]);
    }),
  );
});
