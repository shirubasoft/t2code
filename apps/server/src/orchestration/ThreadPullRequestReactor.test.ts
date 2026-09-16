import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import * as ThreadPullRequestReactor from "./ThreadPullRequestReactor.ts";

it.effect("starts and remains idle without any host or orchestration services", () =>
  Effect.gen(function* () {
    const reactor = yield* ThreadPullRequestReactor.make;
    yield* reactor.start();
    yield* TestClock.adjust("1 hour");
    yield* reactor.drain;
    expect(reactor).toBeDefined();
  }).pipe(Effect.scoped),
);
