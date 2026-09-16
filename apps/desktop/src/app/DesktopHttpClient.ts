import { isLoopbackUrl } from "@t3tools/shared/localNetwork";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/unstable/http";

/** Desktop services communicate with their local backend; update downloads use ElectronUpdater. */
export const layer = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return client.pipe(
      HttpClient.transform((response, request) =>
        isLoopbackUrl(request.url)
          ? response.pipe(
              Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
            )
          : Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  cause: new Error("Desktop backend requests must stay on this computer."),
                }),
              }),
            ),
      ),
      HttpClient.followRedirects(10),
    );
  }),
).pipe(Layer.provide(FetchHttpClient.layer));
