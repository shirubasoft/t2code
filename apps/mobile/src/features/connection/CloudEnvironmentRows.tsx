import type { EnvironmentId } from "@t3tools/contracts";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";
import type { RelayEnvironmentView } from "./useConnectionController";

interface CloudEnvironmentRowsProps {
  readonly connectedCloudEnvironments: ReadonlyArray<ConnectedEnvironmentSummary>;
  readonly onSetEnvironmentEnabled: (environmentId: EnvironmentId, enabled: boolean) => void;
  /** Long-press on a saved row. The callback owns the confirm. */
  readonly onRemoveEnvironment: (environmentId: EnvironmentId) => void;
  readonly showcaseAvailableEnvironments?: ReadonlyArray<RelayEnvironmentView>;
  readonly showcaseSignedIn?: boolean;
  /**
   * Hide the "T3 Connect" section title + refresh button for hosts that
   * provide their own chrome (the onboarding sheet's native header and
   * pull-to-refresh).
   */
  readonly showHeader?: boolean;
}

export function CloudEnvironmentRows(_props: CloudEnvironmentRowsProps) {
  return null;
}
