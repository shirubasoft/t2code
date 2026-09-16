import { EllipsisIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useMemo, useState } from "react";
import {
  AuthAccessWriteScope,
  AuthAdministrativeScopes,
  resolveEnvironmentMachineKind,
  type DesktopWslState,
} from "@t3tools/contracts";
import { usePrimarySessionState } from "~/environments/primary";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import {
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  supportsDesktopAppUpdate,
  supportsServerUpdateThreadContinuation,
} from "~/versionSkew";
import { useEnvironmentQuery } from "~/state/query";
import { desktopWslStateAtom, refreshDesktopWslState } from "~/state/desktopWslState";
import { useEnvironments, usePrimaryEnvironment } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import { applyWslEnableSelection, isWslSettingsRowVisible } from "./ConnectionsSettings.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { LocalEnvironmentSetting } from "./LocalEnvironmentSetting";
import { searchableSetting } from "./settingsSearch";
import { EnvironmentIconMenu } from "./EnvironmentIconPicker";
import { LoadBalancingSettings } from "./LoadBalancingSettings";
import { GitHubRoutingSettings } from "./GitHubRoutingSettings";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ServerUpdateAction, ServerUpdateProgress } from "../ServerUpdateAction";
import { Button } from "../ui/button";
import { Menu, MenuTrigger, MenuPopup } from "../ui/menu";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { Switch } from "../ui/switch";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogClose,
} from "../ui/alert-dialog";

const BACKEND_VALUE_DEFAULT_WSL = "backend:default-wsl";
const BACKEND_VALUE_WSL_OFF = "backend:wsl-off";

export function ConnectionsSettings() {
  const desktopBridge = window.desktopBridge;
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  const primarySessionState = usePrimarySessionState();
  const currentSessionScopes = desktopBridge
    ? AuthAdministrativeScopes
    : primarySessionState.data?.authenticated
      ? (primarySessionState.data.scopes ?? null)
      : null;
  const canManageLocalBackend =
    !isLocalEnvironmentDisabled() &&
    (currentSessionScopes?.includes(AuthAccessWriteScope) ?? false);
  const primaryServerConfig = primaryEnvironment?.serverConfig ?? null;
  const primaryVersionMismatch = resolveServerConfigVersionMismatch(primaryServerConfig);
  const primaryServerUpdateState = useAtomValue(
    serverEnvironment.updateStateAtom(primaryEnvironmentId),
  );
  const loadBalancingEnvironments = environments.filter((environment) => environment.entry.enabled);
  const [isUpdatingWslBackend, setIsUpdatingWslBackend] = useState(false);
  const [desktopWslMutationError, setDesktopWslMutationError] = useState<string | null>(null);
  // Pending WSL setting change waiting on user confirmation. Set when
  // the user tries a destructive change (disable, switch distro,
  // toggle wsl-only) while the WSL backend has saved-env state on this
  // machine. Confirming applies the change; cancelling drops it
  // without touching the persisted setting. Null when nothing is
  // pending.
  type PendingWslChange =
    // wasWslOnly is true when the user picked Off while wsl-only mode
    // was active. In that case "disable" also clears wsl-only and
    // relaunches onto the Windows backend, because leaving wsl-only on
    // with wslBackendEnabled off is a meaningless state (wsl-only is
    // only honoured when the WSL backend is enabled).
    | { readonly kind: "disable"; readonly wasWslOnly: boolean }
    | { readonly kind: "distro"; readonly nextDistro: string | null }
    // Asked at enable time so the user picks the mode upfront instead
    // of being dropped into "both backends" and having to discover the
    // wsl-only switch separately. Resolved through enable-mode action
    // buttons on the dialog rather than a single Confirm.
    | { readonly kind: "enable"; readonly nextDistro: string | null }
    | { readonly kind: "wsl-only"; readonly nextValue: boolean };
  const [pendingWslChange, setPendingWslChange] = useState<PendingWslChange | null>(null);
  const isWslConfirmDialogOpen = pendingWslChange !== null;
  const desktopWsl = useEnvironmentQuery(
    canManageLocalBackend && desktopBridge ? desktopWslStateAtom : null,
  );
  const desktopWslState = desktopWsl.data;
  const desktopWslError = desktopWslMutationError ?? desktopWsl.error;
  const isLoadingWslState = desktopWsl.isPending && desktopWsl.data === null;

  const applyWslSettingChange = useCallback(
    async (apply: () => Promise<DesktopWslState>) => {
      if (!desktopBridge) return;
      setIsUpdatingWslBackend(true);
      setDesktopWslMutationError(null);
      try {
        await apply();
        refreshDesktopWslState();
        // The connection platform source polls the desktop bootstrap list and
        // reconciles the environment catalog automatically, so toggling the WSL
        // backend on/off or switching distros is picked up here without an
        // explicit renderer reconcile.
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to update WSL backend.";
        setDesktopWslMutationError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not change WSL backend",
            description: message,
          }),
        );
        refreshDesktopWslState();
      } finally {
        setIsUpdatingWslBackend(false);
      }
    },
    [desktopBridge],
  );

  // Reload the keep-alive WSL state atom. Clearing the mutation error before
  // refresh lets the atom-owned load error become the visible retry state.
  const loadWslState = useCallback(() => {
    setDesktopWslMutationError(null);
    refreshDesktopWslState();
  }, []);

  // True when a desktop-local WSL backend is currently registered as an
  // environment on this machine. We use this as a proxy for "the user has work
  // that lives on the WSL side": if WSL has connected in a way that registered
  // the env, disabling or switching distros could disrupt open threads/projects.
  // If WSL never connected (fresh install, toggled on then immediately off,
  // etc.) there's no local environment, so we skip the confirmation dialog.
  const hasWslRegistrationToLose = useMemo(() => {
    return environments.some((environment) =>
      isDesktopLocalConnectionTarget(environment.entry.target),
    );
  }, [environments]);

  // Single picker for "WSL backend off" vs "running on distro X". The
  // dropdown maps "Off" to disable and any distro entry to enable +
  // run on that distro. Splitting these into a separate switch and
  // dropdown was confusing — they're the same decision.
  const handleSelectWslMode = useCallback(
    (value: string) => {
      if (!desktopBridge || !desktopWslState) return;
      const defaultDistroName =
        desktopWslState.distros.find((distro) => distro.isDefault)?.name ?? null;
      if (value === BACKEND_VALUE_WSL_OFF) {
        // Match the recovery row's visibility (`enabled || wslOnly`): when WSL
        // went unavailable while wsl-only was persisted, `enabled` can be false
        // while `wslOnly` is true, and the "Switch to Windows" button must
        // still clear that state instead of silently no-op'ing.
        if (!desktopWslState.enabled && !desktopWslState.wslOnly) return;
        const wasWslOnly = desktopWslState.wslOnly;
        // Confirm when there's WSL state to lose, OR when wsl-only is
        // on (turning the only running backend off needs to switch
        // back to Windows and restart — always consequential).
        if (hasWslRegistrationToLose || wasWslOnly) {
          setPendingWslChange({ kind: "disable", wasWslOnly });
          return;
        }
        void applyWslSettingChange(() => desktopBridge.setWslBackendEnabled(false));
        return;
      }
      const nextDistro = value === BACKEND_VALUE_DEFAULT_WSL ? null : value;
      const resolvedNext = nextDistro ?? defaultDistroName;
      if (!desktopWslState.enabled) {
        // Was off, user picked a distro: ask whether to run both
        // backends or only WSL. We always ask here so the user picks
        // the mode upfront instead of having to discover the wsl-only
        // switch afterwards.
        setPendingWslChange({ kind: "enable", nextDistro });
        return;
      }
      // Already enabled — treat as a distro switch. Skip the change if
      // the user re-picked the row that's already selected.
      const resolvedCurrent = desktopWslState.distro ?? defaultDistroName;
      if (resolvedCurrent === resolvedNext) return;
      // Confirm when there's WSL registration to lose, OR in wsl-only mode:
      // there the primary IS the WSL backend, so a distro change relaunches
      // the app (the IPC handler does this) rather than swapping a secondary,
      // and the user should see that coming.
      if (hasWslRegistrationToLose || desktopWslState.wslOnly) {
        setPendingWslChange({ kind: "distro", nextDistro });
        return;
      }
      void applyWslSettingChange(() => desktopBridge.setWslDistro(nextDistro));
    },
    [applyWslSettingChange, desktopBridge, desktopWslState, hasWslRegistrationToLose],
  );

  // Dispatched from the enable modal's two action buttons.
  const handleConfirmEnableWsl = useCallback(
    (mode: "both" | "wsl-only") => {
      if (!desktopBridge || !pendingWslChange || pendingWslChange.kind !== "enable") return;
      const nextDistro = pendingWslChange.nextDistro;
      setPendingWslChange(null);
      const persistedDistro = desktopWslState?.distro ?? null;
      void applyWslSettingChange(() =>
        applyWslEnableSelection({
          bridge: desktopBridge,
          mode,
          nextDistro,
          persistedDistro,
        }),
      );
    },
    [applyWslSettingChange, desktopBridge, desktopWslState, pendingWslChange],
  );

  const handleToggleWslOnly = useCallback(
    (enabled: boolean) => {
      if (!desktopBridge || !desktopWslState || desktopWslState.wslOnly === enabled) return;
      // wsl-only changes which backend the pool uses as "primary",
      // which is decided once at app launch. The desktop side persists
      // the setting immediately but doesn't tear down or restart
      // anything itself; the renderer warns the user to expect a
      // restart and (in a follow-up) can trigger it automatically.
      // Always prompt — even enabling is consequential here.
      setPendingWslChange({ kind: "wsl-only", nextValue: enabled });
    },
    [desktopBridge, desktopWslState],
  );

  const handleConfirmWslChange = useCallback(() => {
    if (!desktopBridge || !pendingWslChange) return;
    const change = pendingWslChange;
    // The enable kind resolves through handleConfirmEnableWsl, not
    // this single Confirm path.
    if (change.kind === "enable") return;
    setPendingWslChange(null);
    if (change.kind === "disable") {
      void applyWslSettingChange(async () => {
        const next = await desktopBridge.setWslBackendEnabled(false);
        if (change.wasWslOnly) {
          // Clearing wsl-only relaunches onto the Windows backend.
          return await desktopBridge.setWslOnly(false);
        }
        return next;
      });
      return;
    }
    if (change.kind === "distro") {
      void applyWslSettingChange(() => desktopBridge.setWslDistro(change.nextDistro));
      return;
    }
    void applyWslSettingChange(() => desktopBridge.setWslOnly(change.nextValue));
  }, [applyWslSettingChange, desktopBridge, pendingWslChange]);

  const renderWslRow = () => {
    if (!desktopWslState) {
      // A load failed: keep a recovery row (with retry) visible instead of
      // silently hiding the section. The error persists across an in-flight
      // retry so the row doesn't flicker away, and the button reflects the
      // loading state. With no error we simply haven't loaded yet (or WSL
      // management isn't available), so render nothing.
      if (
        isWslSettingsRowVisible({ state: null, error: desktopWslError }) &&
        canManageLocalBackend
      ) {
        return (
          <SettingsRow
            {...searchableSetting("wsl-backend")}
            description="Couldn't load the WSL backend state."
            status={<span className="block text-destructive">{desktopWslError}</span>}
            control={
              <Button
                size="sm"
                variant="outline"
                onClick={loadWslState}
                disabled={isLoadingWslState}
              >
                {isLoadingWslState ? "Retrying…" : "Retry"}
              </Button>
            }
          />
        );
      }
      return null;
    }
    // WSL went unavailable while the user still has the WSL backend persisted
    // (it may have been uninstalled or its distro removed). The desktop side
    // falls back to the Windows backend, but the normal distro picker needs a
    // live distro list it no longer has. Without a control here the user would
    // be stranded on a WSL preference they can't clear, so render a recovery
    // row that switches back to Windows. When WSL is unavailable AND unused,
    // there's nothing to recover — keep the section hidden as before.
    if (!isWslSettingsRowVisible({ state: desktopWslState, error: desktopWslError })) {
      return null;
    }
    if (!desktopWslState.available) {
      return (
        <SettingsRow
          {...searchableSetting("wsl-backend")}
          description="WSL is unavailable, so Windows is running instead. Turn WSL off to clear this preference."
          status={
            desktopWslError ? (
              <span className="block text-destructive">{desktopWslError}</span>
            ) : null
          }
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={isUpdatingWslBackend}
              onClick={() => handleSelectWslMode(BACKEND_VALUE_WSL_OFF)}
            >
              Switch to Windows
            </Button>
          }
        />
      );
    }
    // Distro is null when the user wants the WSL default. Map it to the
    // real default's name so the Select highlights a real option; fall
    // back to the sentinel only when no distros are listed yet (the
    // dropdown then renders a single placeholder that matches).
    const defaultDistroName =
      desktopWslState.distros.find((distro) => distro.isDefault)?.name ?? null;
    const selectValue = !desktopWslState.enabled
      ? BACKEND_VALUE_WSL_OFF
      : (desktopWslState.distro ?? defaultDistroName ?? BACKEND_VALUE_DEFAULT_WSL);
    const selectLabel =
      selectValue === BACKEND_VALUE_WSL_OFF
        ? "Off"
        : selectValue === BACKEND_VALUE_DEFAULT_WSL
          ? "Default distro"
          : selectValue;
    return (
      <>
        <SettingsRow
          {...searchableSetting("wsl-backend")}
          description="Run the selected WSL distro alongside Windows. Projects remain on their current filesystem."
          status={
            desktopWslError ? (
              <span className="block text-destructive">{desktopWslError}</span>
            ) : desktopWslState.preflightError ? (
              <span className="block text-destructive">
                WSL backend couldn't start: {desktopWslState.preflightError}
              </span>
            ) : null
          }
          control={
            <Select
              value={selectValue}
              onValueChange={(value) => {
                if (typeof value !== "string") return;
                handleSelectWslMode(value);
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-56"
                aria-label="WSL backend"
                disabled={isUpdatingWslBackend}
              >
                <SelectValue>{selectLabel}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value={BACKEND_VALUE_WSL_OFF}>
                  Off
                </SelectItem>
                {desktopWslState.distros.length === 0 ? (
                  <SelectItem hideIndicator value={BACKEND_VALUE_DEFAULT_WSL}>
                    Default distro
                  </SelectItem>
                ) : (
                  desktopWslState.distros.map((distro) => (
                    <SelectItem hideIndicator key={distro.name} value={distro.name}>
                      {distro.name}
                      {distro.isDefault ? " (default)" : ""}
                    </SelectItem>
                  ))
                )}
              </SelectPopup>
            </Select>
          }
        />
        {desktopWslState.enabled ? (
          <SettingsRow
            title="WSL only"
            description="Run only the WSL backend. T3 Code restarts when this changes."
            className="bg-muted/20 pl-7 sm:pl-8"
            control={
              <Switch
                checked={desktopWslState.wslOnly}
                disabled={isUpdatingWslBackend}
                onCheckedChange={(checked) => handleToggleWslOnly(checked)}
                aria-label="Run WSL only"
              />
            }
          />
        ) : null}
      </>
    );
  };

  return (
    <SettingsPageContainer width="wide">
      <SettingsSection
        {...searchableSetting("connections-environment")}
        title={
          primaryEnvironment?.label ?? (desktopBridge ? "This machine" : "Primary environment")
        }
        icon={
          <EnvironmentMachineIcon
            aria-hidden
            kind={
              primaryServerConfig ? resolveEnvironmentMachineKind(primaryServerConfig) : "desktop"
            }
            className="size-4"
          />
        }
        headerAction={
          primaryEnvironmentId !== null ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="More actions for this machine"
                  />
                }
              >
                <EllipsisIcon className="size-3.5" />
              </MenuTrigger>
              <MenuPopup align="end" className="min-w-52">
                <EnvironmentIconMenu
                  environmentId={primaryEnvironmentId}
                  serverConfig={primaryServerConfig}
                />
              </MenuPopup>
            </Menu>
          ) : null
        }
      >
        <LocalEnvironmentSetting />
        {canManageLocalBackend ? (
          <SettingsRow
            title="Version"
            description={
              primaryServerUpdateState.status !== "idle" ? (
                <ServerUpdateProgress state={primaryServerUpdateState} />
              ) : (
                [
                  primaryServerConfig?.environment.serverVersion ?? null,
                  primaryEnvironment?.displayUrl ?? null,
                ]
                  .filter((value): value is string => value !== null)
                  .join(" · ") || "Loading…"
              )
            }
            control={
              primaryVersionMismatch &&
              primaryEnvironmentId !== null &&
              primaryServerUpdateState.status !== "running" ? (
                <ServerUpdateAction
                  size="sm"
                  environmentId={primaryEnvironmentId}
                  serverLabel={primaryEnvironment ? `${primaryEnvironment.label} server` : "server"}
                  selfUpdate={resolveServerSelfUpdateCapability(primaryServerConfig)}
                  desktopAppUpdate={supportsDesktopAppUpdate(primaryServerConfig)}
                  threadContinuation={supportsServerUpdateThreadContinuation(primaryServerConfig)}
                  targetVersion={primaryVersionMismatch.clientVersion}
                  label={
                    primaryServerUpdateState.status === "failed"
                      ? "Retry update"
                      : `Update to ${primaryVersionMismatch.clientVersion}`
                  }
                />
              ) : primaryServerUpdateState.status === "idle" && primaryServerConfig ? (
                <span className="text-xs text-muted-foreground">Up to date</span>
              ) : undefined
            }
          />
        ) : null}
        {canManageLocalBackend && desktopBridge ? renderWslRow() : null}
      </SettingsSection>
      <AlertDialog
        open={isWslConfirmDialogOpen}
        onOpenChange={(open) => {
          if (isUpdatingWslBackend) return;
          if (!open) setPendingWslChange(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingWslChange?.kind === "disable"
                ? pendingWslChange.wasWslOnly
                  ? "Turn off WSL and switch back to Windows?"
                  : "Disable WSL backend?"
                : pendingWslChange?.kind === "distro"
                  ? "Switch WSL distro?"
                  : pendingWslChange?.kind === "enable"
                    ? "Start the WSL backend"
                    : pendingWslChange?.nextValue
                      ? "Run only the WSL backend?"
                      : "Re-enable the Windows backend?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingWslChange?.kind === "disable"
                ? pendingWslChange.wasWslOnly
                  ? "T3 Code will restart on the Windows backend. Threads and projects opened against WSL stay safe inside the distro and become available again when you re-enable WSL."
                  : "The WSL backend will stop. Threads and projects opened against WSL stay safe inside the distro, but they'll be unavailable in T3 Code until you re-enable WSL."
                : pendingWslChange?.kind === "distro"
                  ? "T3 Code will restart the WSL backend on the new distro. Sessions still running on the current distro will be interrupted."
                  : pendingWslChange?.kind === "enable"
                    ? "Run the WSL backend alongside the Windows one, or stop the Windows backend and use only WSL? You can change this later from Settings."
                    : pendingWslChange?.nextValue
                      ? "T3 Code will restart and start only the WSL backend. Your Windows-side projects won't be accessible until you turn this off again."
                      : "T3 Code will restart and bring the Windows backend back up alongside WSL."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={isUpdatingWslBackend}
              render={<Button variant="outline" disabled={isUpdatingWslBackend} />}
            >
              Cancel
            </AlertDialogClose>
            {pendingWslChange?.kind === "enable" ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => handleConfirmEnableWsl("wsl-only")}
                  disabled={isUpdatingWslBackend}
                >
                  {isUpdatingWslBackend ? (
                    <>
                      <Spinner className="size-3.5" />
                      Applying…
                    </>
                  ) : (
                    "Use only WSL"
                  )}
                </Button>
                <Button
                  variant="default"
                  onClick={() => handleConfirmEnableWsl("both")}
                  disabled={isUpdatingWslBackend}
                >
                  {isUpdatingWslBackend ? (
                    <>
                      <Spinner className="size-3.5" />
                      Applying…
                    </>
                  ) : (
                    "Run both backends"
                  )}
                </Button>
              </>
            ) : (
              <Button
                variant={
                  pendingWslChange?.kind === "disable" ||
                  (pendingWslChange?.kind === "wsl-only" && pendingWslChange.nextValue)
                    ? "destructive"
                    : "default"
                }
                onClick={handleConfirmWslChange}
                disabled={isUpdatingWslBackend}
              >
                {isUpdatingWslBackend ? (
                  <>
                    <Spinner className="size-3.5" />
                    Applying…
                  </>
                ) : pendingWslChange?.kind === "disable" ? (
                  pendingWslChange.wasWslOnly ? (
                    "Switch to Windows"
                  ) : (
                    "Disable WSL"
                  )
                ) : pendingWslChange?.kind === "distro" ? (
                  "Switch distro"
                ) : pendingWslChange?.nextValue ? (
                  "Restart and enable"
                ) : (
                  "Restart and disable"
                )}
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <LoadBalancingSettings environments={loadBalancingEnvironments} />
      <GitHubRoutingSettings environments={loadBalancingEnvironments} />
    </SettingsPageContainer>
  );
}
