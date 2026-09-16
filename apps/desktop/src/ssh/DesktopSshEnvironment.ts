import type {
  DesktopDiscoveredSshHost,
  DesktopSshEnvironmentBootstrap,
  DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import type * as NetService from "@t3tools/shared/Net";
import {
  SshCommandError,
  SshHostDiscoveryError,
  SshInvalidTargetError,
  SshLaunchError,
  SshPairingError,
  SshPasswordPromptError,
  SshReadinessError,
} from "@t3tools/ssh/errors";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";

export type DesktopSshEnvironmentOperationError =
  | SshCommandError
  | SshInvalidTargetError
  | SshLaunchError
  | SshPairingError
  | SshReadinessError
  | SshPasswordPromptError
  | NetService.NetError;

export type DesktopSshEnvironmentDiscoverError = SshHostDiscoveryError;

export type DesktopSshEnvironmentError =
  | DesktopSshEnvironmentDiscoverError
  | DesktopSshEnvironmentOperationError;

export class DesktopSshEnvironment extends Context.Service<
  DesktopSshEnvironment,
  {
    readonly discoverHosts: (input?: {
      readonly homeDir?: string;
    }) => Effect.Effect<readonly DesktopDiscoveredSshHost[], DesktopSshEnvironmentDiscoverError>;
    readonly resolveHost: (
      alias: string,
    ) => Effect.Effect<DesktopSshEnvironmentTarget, SshCommandError | SshInvalidTargetError>;
    readonly ensureEnvironment: (
      target: DesktopSshEnvironmentTarget,
      options?: { readonly issuePairingToken?: boolean },
    ) => Effect.Effect<DesktopSshEnvironmentBootstrap, DesktopSshEnvironmentOperationError>;
    readonly disconnectEnvironment: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<void, DesktopSshEnvironmentOperationError>;
  }
>()("@t3tools/desktop/ssh/DesktopSshEnvironment") {}

export function isDesktopSshPasswordPromptCancellation(
  error: unknown,
): error is SshPasswordPromptError {
  return (
    error instanceof SshPasswordPromptError &&
    DesktopSshPasswordPrompts.isDesktopSshPasswordPromptCancellation(error.cause)
  );
}

/** Retain the IPC contract while excluding SSH remoting from the local edition. */
/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.succeed(
  DesktopSshEnvironment.of({
    discoverHosts: () => Effect.succeed([]),
    resolveHost: () =>
      Effect.fail(
        new SshInvalidTargetError({
          message: "Remote environments are unavailable in the local edition.",
        }),
      ),
    ensureEnvironment: () =>
      Effect.fail(
        new SshInvalidTargetError({
          message: "Remote environments are unavailable in the local edition.",
        }),
      ),
    disconnectEnvironment: () => Effect.void,
  }),
);

export const layer = () => Layer.effect(DesktopSshEnvironment, make);
