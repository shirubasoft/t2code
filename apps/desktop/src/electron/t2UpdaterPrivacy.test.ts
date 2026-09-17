import { describe, expect, it, vi } from "vite-plus/test";
import { AppImageUpdater } from "electron-updater";
import { disableUpdateTracking } from "./t2UpdaterPrivacy.ts";

vi.mock("electron", () => ({ app: {}, net: {} }));

describe("T2 updater privacy", () => {
  it("strips the installed updater's tracking header while retaining download headers", async () => {
    const updater = new AppImageUpdater(null, {
      version: "0.1.1",
      name: "T2 Code",
      isPackaged: true,
      appUpdateConfigPath: "/not-used/app-update.yml",
      userDataPath: "/must-not-read-user-data",
      baseCachePath: "/not-used/cache",
      whenReady: async () => {},
      onQuit: () => {},
      quit: () => {},
      relaunch: () => {},
    });
    updater.requestHeaders = {
      Authorization: "download-credential",
      "X-User-Staging-Id": "secret-id",
    };
    disableUpdateTracking(updater);
    const headers = Reflect.get(updater, "computeFinalHeaders").call(updater, {
      "x-user-staging-id": "another-secret-id",
      accept: "application/octet-stream",
    });
    expect(headers).toEqual({
      Authorization: "download-credential",
      accept: "application/octet-stream",
    });
    await expect(Reflect.get(updater, "getOrCreateStagingUserId").call(updater)).resolves.toBe(
      "00000000-0000-4000-8000-000000000000",
    );
  });
});
