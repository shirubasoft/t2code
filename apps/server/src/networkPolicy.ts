import { isLoopbackUrl } from "@t3tools/shared/localNetwork";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/unstable/http";

/** Granted only while executing an explicit Git or update request. */
export class UserNetworkAccess extends Context.Reference<boolean>("t2/network/UserNetworkAccess", {
  defaultValue: () => false,
}) {}

/** Exact origins of harness endpoints configured by the user for the current operation. */
export class ProviderNetworkOrigins extends Context.Reference<ReadonlyArray<string>>(
  "t2/network/ProviderNetworkOrigins",
  { defaultValue: () => [] },
) {}

function isConfiguredProviderOrigin(url: string, origins: ReadonlyArray<string>): boolean {
  try {
    const target = new URL(url);
    return (
      (target.protocol === "http:" || target.protocol === "https:") &&
      target.username === "" &&
      target.password === "" &&
      origins.includes(target.origin)
    );
  } catch {
    return false;
  }
}

const USER_NETWORK_METHODS = new Set([
  "vcs.pull",
  "vcs.refreshStatus",
  "vcs.createWorktree",
  "git.runStackedAction",
  "git.resolvePullRequest",
  "git.preparePullRequestThread",
  "sourceControl.lookupRepository",
  "sourceControl.cloneRepository",
  "sourceControl.publishRepository",
  "projectClone.start",
  "projectClone.retry",
  "server.discoverSourceControl",
  "server.updateProvider",
  "server.updateServer",
  "server.updateServerWithProgress",
  "provider.install.start",
  "provider.auth.start",
  "provider.auth.complete",
  "pullRequests.invalidate",
  "pullRequests.list",
  "pullRequests.listStats",
  "pullRequests.routing",
  "pullRequests.stack",
  "pullRequests.detail",
  "pullRequests.activity",
  "pullRequests.threadComments",
  "pullRequests.diffFileContents",
  "pullRequests.runAction",
  "pullRequests.update",
  "pullRequests.comment",
  "pullRequests.updateComment",
  "pullRequests.submitReview",
  "pullRequests.replyToThread",
  "pullRequests.setThreadResolution",
  "pullRequests.setReaction",
  "pullRequests.reviewerCandidates",
  "pullRequests.requestReviewers",
  "pullRequests.labelCandidates",
  "pullRequests.setLabels",
]);

export const rpcAllowsNetwork = (method: string) => USER_NETWORK_METHODS.has(method);

/** Guard the shared HTTP transport before a socket or DNS lookup is opened. */
export const layer = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return client.pipe(
      HttpClient.transform((response, request) =>
        Effect.gen(function* () {
          if (
            isLoopbackUrl(request.url) ||
            isConfiguredProviderOrigin(request.url, yield* ProviderNetworkOrigins) ||
            (yield* UserNetworkAccess)
          ) {
            return yield* response.pipe(
              Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
            );
          }
          return yield* new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: new Error(
                "External requests require an explicit Git or update action in T2 Code.",
              ),
            }),
          });
        }),
      ),
      HttpClient.followRedirects(10),
    );
  }),
).pipe(Layer.provide(FetchHttpClient.layer));
