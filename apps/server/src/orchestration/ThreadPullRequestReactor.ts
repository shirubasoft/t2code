import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

export class ThreadPullRequestReactor extends Context.Service<
  ThreadPullRequestReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/ThreadPullRequestReactor") {}

/** Background discovery would contact a source-control host without a user action. */
export const make = Effect.succeed(
  ThreadPullRequestReactor.of({
    start: () => Effect.void,
    drain: Effect.void,
  }),
);
export const layer = Layer.effect(ThreadPullRequestReactor, make);
