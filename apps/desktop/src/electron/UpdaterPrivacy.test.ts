// @effect-diagnostics nodeBuiltinImport:off -- Exercise the vendor updater's native filesystem and HTTP boundary without loading Electron.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import type * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { NsisUpdater } from "electron-updater";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("patched electron-updater privacy", () => {
  it.each([false, true])(
    "checks and downloads from the fork without a staging identity (existing identifier: %s)",
    async (existingIdentifier) => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t2-updater-privacy-"));
      directories.push(root);
      const userDataPath = NodePath.join(root, "userdata");
      NodeFS.mkdirSync(userDataPath);
      const priorIdentifier = "9f02f308-bdc3-4a03-8e34-61a3f89e74ef";
      if (existingIdentifier) {
        NodeFS.writeFileSync(NodePath.join(userDataPath, ".updaterId"), priorIdentifier);
      }
      const appUpdateConfigPath = NodePath.join(root, "app-update.yml");
      NodeFS.writeFileSync(appUpdateConfigPath, "updaterCacheDirName: t2-updater-test\n");
      const readUserDataPath = vi.fn(() => userDataPath);
      const updater = new NsisUpdater(null, {
        version: "1.0.0",
        name: "T2 Code",
        isPackaged: true,
        appUpdateConfigPath,
        get userDataPath() {
          return readUserDataPath();
        },
        baseCachePath: NodePath.join(root, "cache"),
        whenReady: async () => {},
        quit: vi.fn(),
        relaunch: vi.fn(),
        onQuit: vi.fn(),
      });
      updater.logger = null;
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = false;
      updater.disableDifferentialDownload = true;
      updater.disableWebInstaller = true;
      updater.requestHeaders = { "x-test-header": "preserved" };

      const installer = Buffer.from("test installer bytes, never executed");
      const sha512 = NodeCrypto.createHash("sha512").update(installer).digest("base64");
      const requests: NodeHttp.RequestOptions[] = [];
      const downloads: Array<{ url: string; headers: NodeHttp.OutgoingHttpHeaders }> = [];
      let version = "1.0.1";
      // Exercise the installed SDK and its GitHub provider. Replace only the
      // transport so the test can inspect requests without network access.
      Object.defineProperty(updater, "httpExecutor", {
        value: {
          request: async (options: NodeHttp.RequestOptions) => {
            requests.push(options);
            expect(options.hostname).toBe("github.com");
            const path = options.path ?? "";
            if (path === "/shirubasoft/t2code/releases.atom") {
              return `<feed><entry><title>T2 Code ${version}</title><link href="https://github.com/shirubasoft/t2code/releases/tag/v${version}"/><content>Release notes</content></entry></feed>`;
            }
            if (path === "/shirubasoft/t2code/releases/latest") {
              return JSON.stringify({ tag_name: `v${version}` });
            }
            expect(path).toMatch(
              /^\/shirubasoft\/t2code\/releases\/download\/v1\.0\.[01]\/latest(?:-linux(?:-arm64)?|-mac)?\.yml$/,
            );
            return `version: ${version}\nstagingPercentage: 0\nfiles:\n  - url: T2-Code-${version}-x64.exe\n    sha512: ${sha512}\n    size: ${installer.length}\n`;
          },
          download: async (
            url: URL,
            destination: string,
            options: { headers: NodeHttp.OutgoingHttpHeaders; sha512: string },
          ) => {
            downloads.push({ url: url.href, headers: options.headers });
            expect(options.sha512).toBe(sha512);
            NodeFS.writeFileSync(destination, installer);
          },
        },
      });
      updater.setFeedURL({ provider: "github", owner: "shirubasoft", repo: "t2code" });
      const available = vi.fn();
      const downloaded = vi.fn();
      updater.on("update-available", available);
      updater.on("update-downloaded", downloaded);

      const result = await updater.checkForUpdates();
      expect(result?.isUpdateAvailable).toBe(true);
      expect(result?.updateInfo.version).toBe("1.0.1");
      expect(result?.downloadPromise).toBeNull();
      expect(available).toHaveBeenCalledOnce();
      expect(downloads).toHaveLength(0);

      const files = await updater.downloadUpdate();
      expect(files).toHaveLength(1);
      expect(NodeFS.readFileSync(files[0]!)).toEqual(installer);
      expect(downloaded).toHaveBeenCalledOnce();
      expect(downloads[0]?.url).toBe(
        "https://github.com/shirubasoft/t2code/releases/download/v1.0.1/T2-Code-1.0.1-x64.exe",
      );

      version = "1.0.0";
      expect((await updater.checkForUpdates())?.isUpdateAvailable).toBe(false);
      expect(requests).toHaveLength(6);
      for (const headers of [
        ...requests.map((request) => request.headers),
        ...downloads.map((download) => download.headers),
      ]) {
        expect(headers).toHaveProperty("x-test-header", "preserved");
        expect(Object.keys(headers ?? {}).map((name) => name.toLowerCase())).not.toContain(
          "x-user-staging-id",
        );
        expect(JSON.stringify(headers)).not.toContain(priorIdentifier);
      }
      expect(readUserDataPath).not.toHaveBeenCalled();
      expect(NodeFS.readdirSync(userDataPath)).toEqual(existingIdentifier ? [".updaterId"] : []);
      if (existingIdentifier) {
        expect(NodeFS.readFileSync(NodePath.join(userDataPath, ".updaterId"), "utf8")).toBe(
          priorIdentifier,
        );
      }
    },
  );
});
