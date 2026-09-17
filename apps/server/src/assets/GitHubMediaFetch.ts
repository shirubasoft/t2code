import * as Effect from "effect/Effect";
import { HttpServerResponse } from "effect/unstable/http";

/** Preserve the asset route interface without credentials, caching or external requests. */
export const githubMediaResponse = Effect.fn("GitHubMediaFetch.githubMediaResponse")((
  _asset: { readonly url: string; readonly cwd: string; readonly expiresAt: number },
  _requestHeaders: Record<string, string | undefined>,
) =>
  Effect.succeed(
    HttpServerResponse.empty({
      status: 403,
      headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
    }),
  ),
);
