import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  PullRequestOperationError,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  type PullRequestSummary,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { GitManager } from "../git/GitManager.ts";
import {
  PullRequestService,
  type PullRequestMergeEvent,
} from "../pullRequest/PullRequestService.ts";
import { ServerActivation } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadSettlementReactor from "./ThreadSettlementReactor.ts";

const NOW = "2026-08-28T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("settlement-project");
const LINKED_PROJECT_ID = ProjectId.make("linked-settlement-project");

type AutoSettleCommand = Extract<OrchestrationCommand, { readonly type: "thread.auto-settle" }>;

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(1),
  digest: (_algorithm, data) => Effect.succeed(data),
});

function makeProject(
  id: ProjectId = PROJECT_ID,
  workspaceRoot = "/workspace/project",
): OrchestrationProjectShell {
  return {
    id,
    title: `Project ${id}`,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: NOW,
  };
}

function makeThread(
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: PROJECT_ID,
    title: id,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    pullRequests: [],
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: "2026-08-20T00:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function makeSnapshot(
  threads: ReadonlyArray<OrchestrationThreadShell>,
  projects: ReadonlyArray<OrchestrationProjectShell> = [makeProject()],
): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 1,
    projects,
    threads,
    updatedAt: NOW,
  };
}

function makePullRequestSummary(input: {
  readonly projectId: ProjectId;
  readonly repository: string;
  readonly number: number;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt?: string;
}): PullRequestSummary {
  return {
    provider: "github",
    projectId: input.projectId,
    repository: input.repository,
    number: input.number,
    title: "Pull request",
    url: `https://example.test/${input.repository}/pull/${input.number}`,
    state: input.state,
    headBranch: "feature",
    baseBranch: "main",
    updatedAt: input.updatedAt ?? NOW,
    closedAt: input.state === "closed" ? (input.updatedAt ?? NOW) : null,
    mergedAt: input.state === "merged" ? (input.updatedAt ?? NOW) : null,
  };
}

interface HarnessOptions {
  readonly snapshot: OrchestrationShellSnapshot;
  readonly settings?: ServerSettings;
  readonly branchPullRequest?: GitManager["Service"]["branchPullRequest"];
  readonly pullRequestSummary?: PullRequestService["Service"]["summary"];
  readonly existingWorktreePaths?: ReadonlyArray<string>;
  readonly onDispatch?: (
    command: AutoSettleCommand,
  ) => Effect.Effect<void, OrchestrationCommandInvariantError>;
}

const makeHarness = Effect.fn("makeThreadSettlementHarness")(function* (options: HarnessOptions) {
  const activation = yield* Deferred.make<void>();
  const snapshots = yield* Ref.make(options.snapshot);
  const snapshotReadCount = yield* Ref.make(0);
  const snapshotReads = yield* Queue.unbounded<number>();
  const settings = yield* Ref.make(options.settings ?? DEFAULT_SERVER_SETTINGS);
  const settingsReads = yield* Queue.unbounded<ServerSettings>();
  const settingsChanges = yield* PubSub.unbounded<ServerSettings>();
  const mergedPullRequests = yield* PubSub.unbounded<PullRequestMergeEvent>();
  const commands = yield* Ref.make<ReadonlyArray<AutoSettleCommand>>([]);
  const branchCalls = yield* Ref.make<
    ReadonlyArray<{ readonly cwd: string; readonly branch: string }>
  >([]);
  const summaryCalls = yield* Ref.make<
    ReadonlyArray<{
      readonly projectId: ProjectId;
      readonly repository: string;
      readonly number: number;
    }>
  >([]);
  const summaryRecovery = yield* Ref.make<ReadonlyArray<boolean | undefined>>([]);
  const invalidatedCwds = yield* Ref.make<ReadonlyArray<string>>([]);

  const updateSettings = (patch: ServerSettingsPatch) =>
    Effect.gen(function* () {
      const next = applyServerSettingsPatch(yield* Ref.get(settings), patch);
      yield* Ref.set(settings, next);
      yield* PubSub.publish(settingsChanges, next);
      return next;
    });

  const branchPullRequest: GitManager["Service"]["branchPullRequest"] = (input, readOptions) =>
    Ref.update(branchCalls, (calls) => [...calls, input]).pipe(
      Effect.andThen(options.branchPullRequest?.(input, readOptions) ?? Effect.succeed(null)),
    );
  const pullRequestSummary: PullRequestService["Service"]["summary"] = (input, readOptions) =>
    Effect.gen(function* () {
      yield* Ref.update(summaryCalls, (calls) => [...calls, input]);
      yield* Ref.update(summaryRecovery, (values) => [
        ...values,
        readOptions?.recoverTransientFailure,
      ]);
      return yield* (
        options.pullRequestSummary?.(input, readOptions) ??
          Effect.succeed(
            makePullRequestSummary({
              ...input,
              state: "open",
            }),
          )
      );
    });

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) => {
    if (command.type !== "thread.auto-settle") {
      return Effect.die(new Error(`Unexpected command: ${command.type}`));
    }
    return Ref.update(commands, (recorded) => [...recorded, command]).pipe(
      Effect.andThen(options.onDispatch?.(command) ?? Effect.void),
      Effect.as({ sequence: 1 }),
    );
  };

  const serverSettings = ServerSettingsService.of({
    start: Effect.void,
    ready: Effect.void,
    getSettings: Ref.get(settings).pipe(Effect.tap((value) => Queue.offer(settingsReads, value))),
    updateSettings,
    streamChanges: Stream.fromPubSub(settingsChanges),
    subscribeChanges: PubSub.subscribe(settingsChanges).pipe(
      Effect.map((subscription) => Stream.fromSubscription(subscription)),
    ),
  });

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getShellSnapshot: () =>
        Ref.updateAndGet(snapshotReadCount, (count) => count + 1).pipe(
          Effect.tap((count) => Queue.offer(snapshotReads, count)),
          Effect.andThen(Ref.get(snapshots)),
        ),
    }),
    Layer.mock(GitManager)({
      branchPullRequest,
      invalidateStatus: (cwd) => Ref.update(invalidatedCwds, (cwds) => [...cwds, cwd]),
    }),
    Layer.mock(PullRequestService)({
      summary: pullRequestSummary,
      subscribeMerges: PubSub.subscribe(mergedPullRequests).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.succeed(ServerSettingsService, serverSettings),
    Layer.succeed(ServerActivation, Deferred.await(activation)),
    Layer.succeed(Crypto.Crypto, testCrypto),
    FileSystem.layerNoop({
      exists: (path) => Effect.succeed(options.existingWorktreePaths?.includes(path) ?? false),
    }),
  );

  return {
    activation,
    snapshots,
    snapshotReadCount,
    snapshotReads,
    settingsReads,
    commands,
    branchCalls,
    summaryCalls,
    summaryRecovery,
    invalidatedCwds,
    updateSettings,
    publishMerge: PubSub.publish(mergedPullRequests, {
      projectId: PROJECT_ID,
      repository: "owner/repository",
      number: 42,
      mergedAt: NOW,
    }),
    layer: ThreadSettlementReactor.layer.pipe(Layer.provide(dependencies)),
  };
});

const startHarness = Effect.fn("startThreadSettlementHarness")(function* (
  reactor: ThreadSettlementReactor.ThreadSettlementReactor["Service"],
  activation: Deferred.Deferred<void>,
  snapshotReads: Queue.Queue<number>,
) {
  yield* reactor.start();
  yield* Deferred.succeed(activation, undefined);
  yield* Queue.take(snapshotReads);
  yield* reactor.drain;
});

describe("ThreadSettlementReactor", () => {
  it("distinguishes a project that inherits the threshold from one that disables it", () => {
    const inherits = ThreadSettlementReactor.autoSettlementSettingsKey({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [PROJECT_ID]: { sidebarAutoSettleOnMerge: true } },
    });
    const never = ThreadSettlementReactor.autoSettlementSettingsKey({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [PROJECT_ID]: { sidebarAutoSettleOnMerge: true, sidebarAutoSettleAfterDays: null },
      },
    });
    assert.notStrictEqual(inherits, never);
  });

  it("ignores project overrides that do not touch settlement", () => {
    const base = ThreadSettlementReactor.autoSettlementSettingsKey({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [PROJECT_ID]: { sidebarAutoSettleOnMerge: false } },
    });
    const unrelated = ThreadSettlementReactor.autoSettlementSettingsKey({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [LINKED_PROJECT_ID]: { defaultThreadEnvMode: "worktree" },
        [PROJECT_ID]: { sidebarAutoSettleOnMerge: false, defaultAutoPull: true },
      },
    });
    assert.strictEqual(base, unrelated);
  });

  it.effect(
    "settles all-terminal links from snapshots and keeps open or unsynced links active",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(NOW));
          const link = (number: number, state: "open" | "merged" | null) => ({
            host: "example.test",
            repository: "owner/repository",
            number,
            url: `https://example.test/owner/repository/pull/${number}`,
            source: "manual" as const,
            linkedAt: NOW,
            stack: null,
            snapshot:
              state === null
                ? null
                : {
                    state,
                    title: "Review",
                    headBranch: "feature",
                    baseBranch: "main",
                    isDraft: false,
                    updatedAt: NOW,
                    syncedAt: NOW,
                    mergedAt: state === "merged" ? NOW : null,
                  },
          });
          const fixture = yield* makeHarness({
            snapshot: makeSnapshot([
              makeThread("merged", { pullRequests: [link(1, "merged"), link(2, "merged")] }),
              makeThread("open", { pullRequests: [link(1, "merged"), link(2, "open")] }),
              makeThread("unsynced", { pullRequests: [link(1, "merged"), link(2, null)] }),
            ]),
            settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleOnMerge: true },
            branchPullRequest: () => Effect.die("linked threads must not query the branch"),
            pullRequestSummary: () => Effect.die("linked threads must use their snapshots"),
          });
          yield* Effect.gen(function* () {
            const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
            yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
            assert.deepStrictEqual(
              (yield* Ref.get(fixture.commands)).map(({ threadId }) => threadId),
              [ThreadId.make("merged")],
            );
            assert.deepStrictEqual(yield* Ref.get(fixture.branchCalls), []);
            assert.deepStrictEqual(yield* Ref.get(fixture.summaryCalls), []);
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
  );
  it.effect("skips PR work on startup, timer and merge sweeps when settlement is disabled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("branch-thread", { branch: "feature" }),
            makeThread("linked-thread", {
              linkedPullRequest: {
                projectId: PROJECT_ID,
                repository: "owner/repository",
                number: 42,
                url: "https://example.test/owner/repository/pull/42",
              },
            }),
          ]),
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            sidebarAutoSettleAfterDays: null,
            sidebarAutoSettleOnMerge: false,
          },
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* reactor.start();
          yield* Queue.take(fixture.settingsReads);
          yield* Deferred.succeed(fixture.activation, undefined);
          yield* Queue.take(fixture.settingsReads);
          yield* reactor.drain;
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(fixture.settingsReads);
          yield* reactor.drain;
          yield* fixture.publishMerge;
          yield* Queue.take(fixture.settingsReads);
          yield* reactor.drain;

          assert.deepStrictEqual(yield* Ref.get(fixture.branchCalls), []);
          assert.deepStrictEqual(yield* Ref.get(fixture.summaryCalls), []);
          assert.deepStrictEqual(yield* Ref.get(fixture.invalidatedCwds), []);
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
          assert.strictEqual(yield* Ref.get(fixture.snapshotReadCount), 0);

          yield* fixture.updateSettings({ sidebarAutoSettleAfterDays: 1 });
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
          // Inactive threads settle without a PR lookup, so only the dispatches prove work resumed.
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId).toSorted(),
            [ThreadId.make("branch-thread"), ThreadId.make("linked-thread")],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("a project override settles only that project's inactive threads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const overriddenProject = ProjectId.make("overridden-project");
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(
            [
              makeThread("inherits-thread"),
              makeThread("overridden-thread", { projectId: overriddenProject }),
            ],
            [makeProject(), makeProject(overriddenProject, "/workspace/overridden")],
          ),
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            sidebarAutoSettleAfterDays: null,
            sidebarAutoSettleOnMerge: false,
            projectSettingsOverrides: {
              [overriddenProject]: { sidebarAutoSettleAfterDays: 1 },
            },
          },
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* reactor.start();
          yield* Queue.take(fixture.settingsReads);
          yield* Deferred.succeed(fixture.activation, undefined);
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            [ThreadId.make("overridden-thread")],
          );

          // Clearing the override is a settlement change, so the sweep re-arms.
          yield* fixture.updateSettings({
            projectSettingsOverrides: { [overriddenProject]: null },
            sidebarAutoSettleAfterDays: 1,
          });
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
          // The static snapshot never records the first settlement, so the
          // second sweep dispatches for both; the inheriting thread is new.
          assert.include(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            ThreadId.make("inherits-thread"),
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("settles inactive linked and branch threads without reading an unavailable host", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("inactive-linked", {
              linkedPullRequest: {
                projectId: PROJECT_ID,
                repository: "owner/repository",
                number: 42,
                url: "https://example.test/owner/repository/pull/42",
              },
            }),
            makeThread("inactive-branch", {
              branch: "saved-feature",
              latestUserMessageAt: "2026-08-21T00:00:00.000Z",
            }),
          ]),
          branchPullRequest: () => Effect.die(new Error("host unavailable")),
          pullRequestSummary: () =>
            Effect.fail(
              new PullRequestOperationError({
                operation: "summary",
                detail: "host unavailable",
              }),
            ),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands))
              .map(({ threadId, snapshotSequence, settledAt }) => ({
                threadId,
                snapshotSequence,
                settledAt,
              }))
              .sort((left, right) => left.threadId.localeCompare(right.threadId)),
            [
              {
                threadId: ThreadId.make("inactive-branch"),
                snapshotSequence: 1,
                settledAt: "2026-08-21T00:00:00.000Z",
              },
              {
                threadId: ThreadId.make("inactive-linked"),
                snapshotSequence: 1,
                settledAt: "2026-08-20T00:00:00.000Z",
              },
            ],
          );
          assert.deepStrictEqual(yield* Ref.get(fixture.summaryCalls), []);
          assert.deepStrictEqual(yield* Ref.get(fixture.branchCalls), []);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("carries the snapshot guard and survives a stale dispatch rejection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([makeThread("stale"), makeThread("next-candidate")]),
          onDispatch: (command) =>
            command.threadId === ThreadId.make("stale")
              ? Effect.fail(
                  new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: "thread changed after settlement evaluation",
                  }),
                )
              : Effect.void,
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);

          const firstSweep = yield* Ref.get(fixture.commands);
          assert.strictEqual(
            firstSweep.find((command) => command.threadId === ThreadId.make("stale"))
              ?.snapshotSequence,
            1,
          );
          assert.strictEqual(
            firstSweep.some((command) => command.threadId === ThreadId.make("next-candidate")),
            true,
          );

          yield* fixture.updateSettings({ sidebarAutoSettleAfterDays: 4 });
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
          assert.strictEqual((yield* Ref.get(fixture.commands)).length, 4);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
  it.effect("keeps unknown host state local through startup, timers, and merge receipts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const settled = yield* Deferred.make<void>();
        const reference = {
          projectId: PROJECT_ID,
          repository: "owner/repository",
          number: 42,
          url: "https://example.test/owner/repository/pull/42",
        };
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("merged-in-app", {
              latestUserMessageAt: "2026-08-27T00:00:00.000Z",
              linkedPullRequest: reference,
            }),
            makeThread("other", {
              latestUserMessageAt: "2026-08-27T00:00:00.000Z",
              linkedPullRequest: { ...reference, number: 99 },
            }),
            makeThread("unknown-branch", {
              latestUserMessageAt: "2026-08-27T00:00:00.000Z",
              branch: "unknown",
            }),
          ]),
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleOnMerge: true },
          branchPullRequest: () => Effect.die("No automatic branch request is allowed"),
          pullRequestSummary: () => Effect.die("No automatic summary request is allowed"),
          onDispatch: () => Deferred.succeed(settled, undefined),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
          yield* fixture.publishMerge;
          yield* Deferred.await(settled);
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            [ThreadId.make("merged-in-app")],
          );
          assert.deepStrictEqual(yield* Ref.get(fixture.branchCalls), []);
          assert.deepStrictEqual(yield* Ref.get(fixture.summaryCalls), []);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
});
