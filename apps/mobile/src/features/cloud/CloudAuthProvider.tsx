import { setManagedRelaySession } from "@t3tools/client-runtime/relay";
import { type ReactNode, useEffect } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { setAgentAwarenessRelayTokenProvider } from "../agent-awareness/remoteRegistration";

export function deactivateCloudRelayAccount(): void {
  setAgentAwarenessRelayTokenProvider(null);
  setManagedRelaySession(appAtomRegistry, null);
}

export function CloudAuthProvider(props: { readonly children: ReactNode }) {
  useEffect(deactivateCloudRelayAccount, []);
  return props.children;
}
