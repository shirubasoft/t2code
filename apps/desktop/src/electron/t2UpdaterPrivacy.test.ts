import { describe, expect, it, vi } from "vite-plus/test";
import { AppImageUpdater } from "electron-updater";
import { disableUpdateTracking } from "./t2UpdaterPrivacy.ts";

vi.mock("electron", () => ({ app: {}, net: {} }));

describe("T2 updater privacy", () => {
  it("checks for real updates without accessing an identity or sending its header", async () => {
    const updater = new AppImageUpdater(null, {
      version: "0.1.1",
      name: "T2 Code",
      isPackaged: true,
      appUpdateConfigPath: "/not-used/app-update.yml",
      get userDataPath(): string {
        throw new Error("Update checking must not access the tracking identity");
      },
      baseCachePath: "/not-used/cache",
      whenReady: async () => {},
      onQuit: () => {},
      quit: () => {},
      relaunch: () => {},
    });
    const request = vi.fn<(options: { headers?: Record<string, unknown> }) => Promise<string>>(
      async () =>
        "version: 0.1.2\nfiles:\n  - url: T2-Code.AppImage\n    sha512: AA==\n    size: 1\n",
    );
    Object.defineProperty(updater, "httpExecutor", { value: { request } });
    updater.forceDevUpdateConfig = true;
    updater.autoDownload = false;
    updater.logger = null;
    updater.requestHeaders = {
      Authorization: "download-credential",
      "X-User-Staging-Id": "secret-id",
    };
    disableUpdateTracking(updater);
    updater.setFeedURL({ provider: "generic", url: "https://updates.test/releases/" });

    disableUpdateTracking(updater);
    const update = await updater.checkForUpdates();

    expect(update?.isUpdateAvailable).toBe(true);
    expect(update?.updateInfo.version).toBe("0.1.2");
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0].headers).toEqual({ Authorization: "download-credential" });
  });
});
