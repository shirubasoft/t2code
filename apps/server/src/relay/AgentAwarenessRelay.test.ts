import { it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as AgentAwarenessRelay from "./AgentAwarenessRelay.ts";

it.effect("starts and handles activity without credentials, identity, or network services", () =>
  Effect.gen(function* () {
    const relay = yield* AgentAwarenessRelay.make;
    yield* relay.start();
    yield* relay.publishThread(ThreadId.make("local-thread"));
  }),
);
