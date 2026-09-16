import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { fromYaml } from "@t3tools/shared/schemaYaml";

const decodeYaml = Schema.decodeUnknownSync(fromYaml(Schema.Unknown));
const sections = ["dependencies", "devDependencies", "optionalDependencies"] as const;
type Dependencies = Partial<Record<(typeof sections)[number], Readonly<Record<string, string>>>>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Missing or invalid reviewed lockfile ${label}.`);
  }
  return value as Record<string, unknown>;
}

function dependencySpecifier(value: unknown, name: string, workspace: Record<string, unknown>) {
  if (typeof value !== "string") throw new Error(`Invalid reviewed specifier for ${name}.`);
  if (!value.startsWith("catalog:")) return value;
  const catalog = record(workspace.catalog, "catalog");
  return catalog[value.slice("catalog:".length) || name];
}

/** Rebase only the importer; package resolutions and their transitive closure stay reviewed. */
export function createStagingLockfile(input: {
  readonly rootLockfile: string;
  readonly rootWorkspace: string;
  readonly importers: readonly string[];
  readonly manifest: Dependencies;
  readonly workspace: Readonly<Record<string, unknown>>;
}) {
  const lock = record(decodeYaml(input.rootLockfile), "root");
  if (lock.lockfileVersion !== "9.0") throw new Error("Unsupported reviewed lockfile version.");
  const rootWorkspace = record(decodeYaml(input.rootWorkspace), "workspace");
  const importers = record(lock.importers, "importers");
  const packages = record(lock.packages, "packages");
  const snapshots = record(lock.snapshots, "snapshots");
  const selectedPackages: Record<string, unknown> = {};
  const selectedSnapshots: Record<string, unknown> = {};
  const queue: string[] = [];

  const snapshotKey = (name: string, version: unknown): string => {
    if (typeof version !== "string") throw new Error(`Missing reviewed version for ${name}.`);
    for (const key of [`${name}@${version}`, version]) {
      if (Object.hasOwn(snapshots, key)) return key;
    }
    throw new Error(`Missing reviewed snapshot for ${name}@${version}.`);
  };

  const importer: Record<string, unknown> = {};
  for (const section of sections) {
    const requested = input.manifest[section];
    if (!requested || Object.keys(requested).length === 0) continue;
    importer[section] = Object.fromEntries(
      Object.entries(requested).map(([name, specifier]) => {
        let version: unknown;
        for (const source of input.importers) {
          const sourceImporter = record(importers[source], `importer ${source}`);
          for (const sourceSection of sections) {
            const sourceDependencies = record(
              sourceImporter[sourceSection] ?? {},
              `${source} ${sourceSection}`,
            );
            if (!Object.hasOwn(sourceDependencies, name)) continue;
            const entry = record(sourceDependencies[name], `${source} ${name}`);
            if (dependencySpecifier(entry.specifier, name, rootWorkspace) !== specifier) {
              throw new Error(
                `Staged specifier for ${name} differs from reviewed importer ${source}.`,
              );
            }
            version = entry.version;
            break;
          }
          if (version !== undefined) break;
        }
        // Native platform siblings are promoted from optional dependencies to
        // explicit roots by the packager. Only an exact accepted snapshot works.
        if (version === undefined && Object.hasOwn(snapshots, `${name}@${specifier}`))
          version = specifier;
        queue.push(snapshotKey(name, version));
        return [name, { specifier, version }];
      }),
    );
  }

  for (let index = 0; index < queue.length; index += 1) {
    const key = queue[index]!;
    if (Object.hasOwn(selectedSnapshots, key)) continue;
    const snapshot = record(snapshots[key], `snapshot ${key}`);
    const packageKey = key.split("(")[0]!;
    const metadata = record(packages[packageKey], `package ${packageKey}`);
    const resolution = record(metadata.resolution, `resolution ${packageKey}`);
    if (typeof resolution.integrity !== "string" || !resolution.integrity.startsWith("sha512-")) {
      throw new Error(`Missing reviewed package integrity for ${packageKey}.`);
    }
    selectedSnapshots[key] = snapshot;
    selectedPackages[packageKey] = metadata;
    for (const section of ["dependencies", "optionalDependencies"] as const) {
      for (const [name, version] of Object.entries(
        record(snapshot[section] ?? {}, `${key} ${section}`),
      )) {
        queue.push(snapshotKey(name, version));
      }
    }
  }

  const patches = Object.fromEntries(
    Object.entries(record(rootWorkspace.patchedDependencies ?? {}, "patch paths")).filter(([key]) =>
      Object.hasOwn(selectedPackages, key),
    ),
  );
  const patchHashes = record(lock.patchedDependencies ?? {}, "patch hashes");
  const selectedPatchHashes = Object.fromEntries(
    Object.keys(patches).map((key) => {
      if (typeof patchHashes[key] !== "string")
        throw new Error(`Missing reviewed patch hash for ${key}.`);
      return [key, patchHashes[key]];
    }),
  );
  const workspace = {
    ...input.workspace,
    ...(rootWorkspace.packageExtensions
      ? { packageExtensions: rootWorkspace.packageExtensions }
      : {}),
    ...(rootWorkspace.peerDependencyRules
      ? { peerDependencyRules: rootWorkspace.peerDependencyRules }
      : {}),
    patchedDependencies: patches,
  };
  const staged = {
    lockfileVersion: lock.lockfileVersion,
    settings: lock.settings,
    ...(lock.overrides ? { overrides: lock.overrides } : {}),
    ...(lock.packageExtensionsChecksum
      ? { packageExtensionsChecksum: lock.packageExtensionsChecksum }
      : {}),
    ...(Object.keys(selectedPatchHashes).length
      ? { patchedDependencies: selectedPatchHashes }
      : {}),
    importers: { ".": importer },
    packages: selectedPackages,
    snapshots: selectedSnapshots,
  };
  return {
    lockfile: JSON.stringify(staged, null, 2) + "\n",
    workspace: JSON.stringify(workspace, null, 2) + "\n",
    hasPatches: Object.keys(patches).length > 0,
  };
}

export class StagingLockfileError extends Schema.TaggedError<StagingLockfileError>()(
  "StagingLockfileError",
  {
    cause: Schema.Defect(),
  },
) {}

export const writeStagingLockfile = Effect.fn("writeStagingLockfile")(function* (input: {
  readonly repoRoot: string;
  readonly stageDir: string;
  readonly importers: readonly string[];
  readonly manifest: Dependencies;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const rootLockfile = yield* fs.readFileString(path.join(input.repoRoot, "pnpm-lock.yaml"));
  const rootWorkspace = yield* fs.readFileString(path.join(input.repoRoot, "pnpm-workspace.yaml"));
  const stageWorkspace = yield* fs.readFileString(path.join(input.stageDir, "pnpm-workspace.yaml"));
  const staged = yield* Effect.try({
    try: () =>
      createStagingLockfile({
        rootLockfile,
        rootWorkspace,
        importers: input.importers,
        manifest: input.manifest,
        workspace: record(decodeYaml(stageWorkspace), "staged workspace"),
      }),
    catch: (cause) => new StagingLockfileError({ cause }),
  });
  yield* fs.writeFileString(path.join(input.stageDir, "pnpm-lock.yaml"), staged.lockfile);
  yield* fs.writeFileString(path.join(input.stageDir, "pnpm-workspace.yaml"), staged.workspace);
  if (staged.hasPatches)
    yield* fs.copy(path.join(input.repoRoot, "patches"), path.join(input.stageDir, "patches"));
});
