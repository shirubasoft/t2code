import type { AppUpdater } from "electron-updater";

/** Keep updater requests functional without reading or sending an installation identifier. */
export function disableUpdateTracking(updater: {
  requestHeaders?: NonNullable<AppUpdater["requestHeaders"]> | null;
}) {
  Object.defineProperties(updater, {
    getOrCreateStagingUserId: {
      value: async () => "00000000-0000-4000-8000-000000000000",
    },
    computeFinalHeaders: {
      value: (headers: NonNullable<AppUpdater["requestHeaders"]>) => {
        const result = { ...headers, ...updater.requestHeaders };
        for (const key of Object.keys(result)) {
          if (key.toLowerCase() === "x-user-staging-id") delete result[key];
        }
        return result;
      },
    },
  });
}
