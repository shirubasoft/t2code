import { CommandId, type ServerSettings as ServerSettingsValue } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import {
  isAutoSettlementCandidate,
  resolveAutoSettlementAt,
  type SettlementPullRequest,
} from "./ThreadSettlementPolicy.ts";

export class ThreadSettlementReactor extends Context.Service<
  ThreadSettlementReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/ThreadSettlementReactor") {}

/** @public Service construction is part of the canonical Effect module API. */
/** Whether any environment default or project override can settle a thread. */
function autoSettlementConfigured(settings: ServerSettingsValue): boolean {
  if (settings.sidebarAutoSettleOnMerge || settings.sidebarAutoSettleAfterDays !== null) {
    return true;
  }
  return Object.values(settings.projectSettingsOverrides).some(
    (entry) =>
      entry.sidebarAutoSettleOnMerge === true ||
      (entry.sidebarAutoSettleAfterDays !== undefined && entry.sidebarAutoSettleAfterDays !== null),
  );
}

/** Identity of every settlement input, so unrelated settings edits do not trigger a sweep. */
/** @internal Exported for tests. */
export function autoSettlementSettingsKey(settings: ServerSettingsValue): string {
  return JSON.stringify([
    settings.sidebarAutoSettleOnMerge,
    settings.sidebarAutoSettleAfterDays,
    // Only entries that touch settlement, in a stable order, so a project
    // override on an unrelated key does not queue a sweep. JSON drops
    // undefined, so inherit (absent) and never (null) need distinct marks.
    Object.entries(settings.projectSettingsOverrides)
      .filter(
        ([, entry]) =>
          entry.sidebarAutoSettleOnMerge !== undefined ||
          entry.sidebarAutoSettleAfterDays !== undefined,
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([projectId, entry]) => [
        projectId,
        entry.sidebarAutoSettleOnMerge ?? "inherit",
        entry.sidebarAutoSettleAfterDays === undefined
          ? "inherit"
          : entry.sidebarAutoSettleAfterDays,
      ]),
  ]);
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const crypto = yield* Crypto.Crypto;

  const sweep = Effect.fn("ThreadSettlementReactor.sweep")(function* (
    mergedPullRequest: PullRequestService.PullRequestMergeEvent | null,
  ) {
    const settings = yield* settingsService.getSettings;
    if (!autoSettlementConfigured(settings)) {
      return;
    }
    const snapshot = yield* snapshots.getShellSnapshot();
    const now = DateTime.formatIso(yield* DateTime.now);
    const candidates = snapshot.threads.filter((thread) => isAutoSettlementCandidate(thread, now));

    // Return the thread when it still needs a pull request decision. A rejected
    // dispatch skips it for this snapshot instead of retrying through a lookup.
    const settleThread = Effect.fn("ThreadSettlementReactor.settleThread")(
      function* (thread: (typeof candidates)[number], pullRequest: SettlementPullRequest | null) {
        const settings = resolveProjectSettings(
          yield* settingsService.getSettings,
          thread.projectId,
        ).settings;
        const decisionNow = DateTime.formatIso(yield* DateTime.now);
        const settledAt = resolveAutoSettlementAt({
          thread,
          pullRequest,
          now: decisionNow,
          autoSettleAfterDays: settings.sidebarAutoSettleAfterDays,
          autoSettleOnMerge: settings.sidebarAutoSettleOnMerge,
        });
        if (settledAt === null) {
          return thread;
        }
        const uuid = yield* crypto.randomUUIDv4;
        yield* engine.dispatch({
          type: "thread.auto-settle",
          commandId: CommandId.make(`server:auto-settle:${thread.id}:${uuid}`),
          threadId: thread.id,
          snapshotSequence: snapshot.snapshotSequence,
          settledAt,
        });
        return null;
      },
      (effect, thread) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("automatic thread settlement skipped", {
                  threadId: thread.id,
                  cause: Cause.pretty(cause),
                }).pipe(Effect.as(null)),
          ),
        ),
    );

    // Persisted snapshots and merge receipts are sufficient for local settlement.
    // Unknown host state waits for the next user-requested source-control refresh.
    yield* Effect.forEach(
      candidates,
      (thread) => {
        const reference = thread.linkedPullRequest ?? thread.branchPullRequest;
        const matchesMerge =
          reference != null &&
          mergedPullRequest !== null &&
          reference.projectId === mergedPullRequest.projectId &&
          reference.repository.toLowerCase() === mergedPullRequest.repository.toLowerCase() &&
          reference.number === mergedPullRequest.number;
        return settleThread(
          thread,
          matchesMerge
            ? {
                state: "merged",
                closedAt: null,
                mergedAt: mergedPullRequest.mergedAt,
              }
            : null,
        );
      },
      { concurrency: 8, discard: true },
    );
  });

  const runSweep = (mergedPullRequest: PullRequestService.PullRequestMergeEvent | null) =>
    sweep(mergedPullRequest).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("automatic thread settlement sweep failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    );
  const worker = yield* makeDrainableWorker(() => runSweep(null));

  const start: ThreadSettlementReactor["Service"]["start"] = Effect.fn(
    "ThreadSettlementReactor.start",
  )(function* () {
    const settingsChanges = yield* settingsService.subscribeChanges;
    const mergedPullRequests = yield* pullRequests.subscribeMerges;
    const initialSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    let lastSettlementSettings = autoSettlementSettingsKey(initialSettings);
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue(undefined);
        yield* worker.drain;
      }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
    yield* forkParked(
      Stream.runForEach(settingsChanges, (settings) => {
        const key = autoSettlementSettingsKey(settings);
        if (key === lastSettlementSettings) {
          return Effect.void;
        }
        lastSettlementSettings = key;
        return worker.enqueue(undefined);
      }),
    );
    yield* forkParked(Stream.runForEach(mergedPullRequests, runSweep));
  });

  return { start, drain: worker.drain } satisfies ThreadSettlementReactor["Service"];
});

export const layer = Layer.effect(ThreadSettlementReactor, make);
