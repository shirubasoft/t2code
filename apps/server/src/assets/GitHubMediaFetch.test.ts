import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import { githubMediaResponse } from "./GitHubMediaFetch.ts";

it.effect("denies remote media without looking up credentials or making an HTTP request", () => {
  let requests = 0;
  let credentialLookups = 0;
  return Effect.gen(function* () {
    for (const url of [
      "https://raw.githubusercontent.com/owner/repo/main/shot.png",
      "https://github.com/user-attachments/assets/image-id",
      "https://media.githubusercontent.com/media/owner/repo/main/clip.mp4",
    ]) {
      const asset = { url, cwd: "/repo", expiresAt: Number.MAX_SAFE_INTEGER };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = yield* githubMediaResponse(asset, { range: "bytes=0-10" });
        expect(response.status).toBe(403);
        expect(response.headers["cache-control"]).toBe("private, no-store");
        expect(response.headers["x-content-type-options"]).toBe("nosniff");
      }
    }
    expect(requests).toBe(0);
    expect(credentialLookups).toBe(0);
  }).pipe(
    Effect.provide(
      Layer.mock(GitHubCli.GitHubCli)({
        execute: () => {
          credentialLookups += 1;
          return Effect.die("Remote media must not look up forge credentials.");
        },
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => {
        requests += 1;
        return Effect.die("Remote media must not make an HTTP request.");
      }),
    ),
  );
});
