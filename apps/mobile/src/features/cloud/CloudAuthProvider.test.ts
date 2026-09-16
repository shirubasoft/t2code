import { managedRelaySessionAtom, setManagedRelaySession } from "@t3tools/client-runtime/relay";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import { deactivateCloudRelayAccount } from "./CloudAuthProvider";
import { setAgentAwarenessRelayTokenProvider } from "../agent-awareness/remoteRegistration";

vi.mock("../agent-awareness/remoteRegistration", () => ({
  setAgentAwarenessRelayTokenProvider: vi.fn(),
}));

afterEach(() => {
  deactivateCloudRelayAccount();
  vi.clearAllMocks();
});

describe("local mobile account state", () => {
  it("clears restored relay credentials without reading an authentication token", () => {
    const tokenProvider = vi.fn(async () => "old-account-token");
    setManagedRelaySession(appAtomRegistry, {
      accountId: "old-account",
      readClerkToken: tokenProvider,
    });
    deactivateCloudRelayAccount();
    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
    expect(vi.mocked(setAgentAwarenessRelayTokenProvider)).toHaveBeenLastCalledWith(null);
    expect(tokenProvider).not.toHaveBeenCalled();
  });
});
