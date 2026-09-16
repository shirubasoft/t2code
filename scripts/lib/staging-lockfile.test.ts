// @effect-diagnostics nodeBuiltinImport:off - Fixtures read the reviewed lock and manifests synchronously.
import * as NodeFS from "node:fs";
import { assert, describe, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import desktopPackage from "../../apps/desktop/package.json" with { type: "json" };
import serverPackage from "../../apps/server/package.json" with { type: "json" };
import {
  createStageWorkspaceConfig,
  resolveDesktopRuntimeDependencies,
  resolveFffNativeDependencies,
  resolveMergedStageDependencies,
} from "../build-desktop-artifact.ts";
import { selectCliRuntimeExternalDependencies } from "./cli-external-packages.ts";
import { resolveCatalogDependencies } from "./resolve-catalog.ts";
import { createStagingLockfile } from "./staging-lockfile.ts";

function fixture() {
  const lock = {
    lockfileVersion: "9.0",
    settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
    patchedDependencies: { "native@1.0.1": "reviewed-patch" },
    importers: {
      "apps/desktop": {
        dependencies: {
          native: { specifier: "^1.0.0", version: "1.0.1(patch_hash=reviewed-patch)" },
        },
      },
    },
    packages: {
      "native@1.0.1": { resolution: { integrity: "sha512-reviewed" } },
      "native-linux@1.0.1": { resolution: { integrity: "sha512-linux" }, os: ["linux"] },
      "native-win32@1.0.1": { resolution: { integrity: "sha512-win32" }, os: ["win32"] },
      "unrelated@2.0.0": { resolution: { integrity: "sha512-unrelated" } },
    },
    snapshots: {
      "native@1.0.1(patch_hash=reviewed-patch)": {
        optionalDependencies: { "native-linux": "1.0.1", "native-win32": "1.0.1" },
      },
      "native-linux@1.0.1": {},
      "native-win32@1.0.1": {},
      "unrelated@2.0.0": {},
    },
  };
  const derive = (dependencies = { native: "^1.0.0" } as Record<string, string>) =>
    createStagingLockfile({
      rootLockfile: JSON.stringify(lock),
      rootWorkspace: JSON.stringify({
        patchedDependencies: { "native@1.0.1": "patches/native.patch" },
      }),
      importers: ["apps/desktop"],
      manifest: { dependencies },
      workspace: {},
    });
  return { lock, derive };
}

describe("reviewed staging lockfile", () => {
  it("keeps the accepted version, integrity, patch and all optional-platform snapshots", () => {
    const { lock, derive } = fixture();
    const result = derive();
    const staged = JSON.parse(result.lockfile);
    assert.equal(
      staged.importers["."].dependencies.native.version,
      "1.0.1(patch_hash=reviewed-patch)",
    );
    assert.deepEqual(staged.packages["native@1.0.1"], lock.packages["native@1.0.1"]);
    assert.deepEqual(
      staged.snapshots["native@1.0.1(patch_hash=reviewed-patch)"],
      lock.snapshots["native@1.0.1(patch_hash=reviewed-patch)"],
    );
    assert.hasAllKeys(staged.packages, [
      "native@1.0.1",
      "native-linux@1.0.1",
      "native-win32@1.0.1",
    ]);
    assert.deepEqual(staged.patchedDependencies, { "native@1.0.1": "reviewed-patch" });
    assert.equal(result.hasPatches, true);
  });

  it("promotes only an exactly locked native sibling to a staged root", () => {
    const { derive } = fixture();
    assert.equal(
      JSON.parse(derive({ "native-linux": "1.0.1" }).lockfile).importers["."].dependencies[
        "native-linux"
      ].version,
      "1.0.1",
    );
    assert.throws(() => derive({ "native-linux": "^1.0.0" }), /Missing reviewed version/);
    assert.throws(() => derive({ "new-package": "1.0.0" }), /Missing reviewed version/);
    assert.throws(() => derive({ native: "^2.0.0" }), /differs from reviewed importer/);
  });

  it("fails before installation when a transitive resolution or integrity is missing", () => {
    const missingSnapshot = fixture();
    Reflect.deleteProperty(missingSnapshot.lock.snapshots, "native-win32@1.0.1");
    assert.throws(() => missingSnapshot.derive(), /Missing reviewed snapshot for native-win32/);
    const missingIntegrity = fixture();
    Reflect.deleteProperty(
      missingIntegrity.lock.packages["native-linux@1.0.1"].resolution,
      "integrity",
    );
    assert.throws(() => missingIntegrity.derive(), /Missing reviewed package integrity/);
  });

  const rootLockfile = NodeFS.readFileSync(
    new URL("../../pnpm-lock.yaml", import.meta.url),
    "utf8",
  );
  const rootWorkspace = NodeFS.readFileSync(
    new URL("../../pnpm-workspace.yaml", import.meta.url),
    "utf8",
  );
  const workspace = Schema.decodeUnknownSync(
    fromYaml(
      Schema.Struct({
        catalog: Schema.Record(Schema.String, Schema.String),
        overrides: Schema.Record(Schema.String, Schema.String),
      }),
    ),
  )(rootWorkspace);
  const server = resolveCatalogDependencies(
    serverPackage.dependencies,
    workspace.catalog,
    "apps/server",
  );
  const desktop = resolveDesktopRuntimeDependencies(desktopPackage.dependencies, workspace.catalog);
  for (const platform of ["mac", "linux", "win"] as const) {
    for (const arch of ["arm64", "x64"] as const) {
      it(`derives desktop and CLI closures for ${platform}/${arch} from the real accepted lock`, () => {
        const stageWorkspace = createStageWorkspaceConfig({
          platform,
          arch,
          overrides: resolveCatalogDependencies(workspace.overrides, workspace.catalog, "stage"),
        });
        const dependencies =
          platform === "win"
            ? desktop
            : resolveMergedStageDependencies({
                platform,
                arch,
                serverDependencies: server,
                desktopDependencies: desktop,
                fffNodeVersion: serverPackage.dependencies["@ff-labs/fff-node"],
              });
        const built = createStagingLockfile({
          rootLockfile,
          rootWorkspace,
          importers: ["apps/desktop", "apps/server"],
          manifest: {
            dependencies,
            devDependencies: { electron: desktopPackage.dependencies.electron },
          },
          workspace: stageWorkspace,
        });
        assert.property(JSON.parse(built.lockfile).packages, "@napi-rs/keyring@1.3.0");
        const cli = createStagingLockfile({
          rootLockfile,
          rootWorkspace,
          importers: ["apps/server"],
          manifest: {
            dependencies: {
              ...selectCliRuntimeExternalDependencies(server),
              ...resolveFffNativeDependencies(
                platform,
                arch,
                serverPackage.dependencies["@ff-labs/fff-node"],
              ),
            },
          },
          workspace: stageWorkspace,
        });
        assert.property(
          JSON.parse(cli.lockfile).packages,
          `@ff-labs/fff-bin-${platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux"}-${arch}${platform === "linux" ? "-gnu" : ""}@0.9.4`,
        );
      });
    }
  }
});
