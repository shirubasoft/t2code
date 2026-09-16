import { isLoopbackUrl } from "@t3tools/shared/localNetwork";
import * as Electron from "electron";

let updateSession: Electron.Session | undefined;
let updateRequests = 0;

export function isLocalRendererRequest(rawUrl: string): boolean {
  if (isLoopbackUrl(rawUrl)) return true;
  try {
    const url = new URL(rawUrl);
    if (["t2code:", "t2code-dev:"].includes(url.protocol)) return url.hostname === "app";
    if (url.protocol === "file:") return url.hostname === "";
    return ["data:", "blob:", "about:"].includes(url.protocol);
  } catch {
    return false;
  }
}

export function isReleaseRequest(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    if (url.hostname === "github.com") {
      return (
        url.pathname === "/shirubasoft/t2code/releases.atom" ||
        url.pathname.startsWith("/shirubasoft/t2code/releases/")
      );
    }
    if (url.hostname === "api.github.com") {
      return (
        url.pathname === "/repos/shirubasoft/t2code/releases" ||
        url.pathname.startsWith("/repos/shirubasoft/t2code/releases/")
      );
    }
    return ["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(
      url.hostname,
    );
  } catch {
    return false;
  }
}

/** The updater gets Internet access only for the lifetime of a requested operation. */
export async function withRequestedUpdateNetwork<A>(operation: () => Promise<A>): Promise<A> {
  updateSession = Electron.session.fromPartition("electron-updater", { cache: false });
  updateRequests += 1;
  try {
    return await operation();
  } finally {
    updateRequests -= 1;
  }
}

/** Cover the main window and every preview partition before their first request. */
export function installLocalNetworkPolicy(): void {
  const configure = (session: Electron.Session) => {
    session.webRequest.onBeforeRequest((details, callback) => {
      const allowed =
        isLocalRendererRequest(details.url) ||
        (session === updateSession && updateRequests > 0 && isReleaseRequest(details.url));
      callback({ cancel: !allowed });
    });
  };
  Electron.app.on("session-created", configure);
}
