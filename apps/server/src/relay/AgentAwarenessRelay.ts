import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

/** Compatibility service for orchestration. Local activity never leaves this environment. */
export class AgentAwarenessRelay extends Context.Service<
  AgentAwarenessRelay,
  {
    readonly publishThread: (threadId: ThreadId) => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/relay/AgentAwarenessRelay") {}

export const make = Effect.succeed(
  AgentAwarenessRelay.of({ publishThread: () => Effect.void, start: () => Effect.void }),
);

export const layer = Layer.effect(AgentAwarenessRelay, make);
