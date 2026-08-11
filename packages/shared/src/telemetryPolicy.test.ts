import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { TELEMETRY_ENABLED } from "./telemetryPolicy.ts";

it("keeps telemetry disabled at compile time", () => {
  expect(TELEMETRY_ENABLED).toBe(false);
});

const productionExtensions = new Set([
  ".astro",
  ".cjs",
  ".js",
  ".json",
  ".mjs",
  ".rs",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

function productionFiles(
  directory: string,
): Effect.Effect<
  ReadonlyArray<string>,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const files: Array<string> = [];

    for (const entry of yield* fileSystem.readDirectory(directory)) {
      const absolutePath = path.join(directory, entry);
      const info = yield* fileSystem.stat(absolutePath);
      if (info.type === "Directory") {
        if (!["dist", "dist-electron", "node_modules"].includes(entry)) {
          files.push(...(yield* productionFiles(absolutePath)));
        }
      } else if (
        productionExtensions.has(path.extname(entry)) &&
        !/\.(?:spec|test)\.[^.]+$/u.test(entry)
      ) {
        files.push(absolutePath);
      }
    }

    return files;
  });
}

it.effect("does not reintroduce telemetry vendors in production code or workflows", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repoRoot = yield* path.fromFileUrl(new URL("../../..", import.meta.url));
    const files = yield* Effect.forEach(
      [".github", "apps", "infra", "native", "packages"],
      (directory) => productionFiles(path.join(repoRoot, directory)),
      { concurrency: "unbounded" },
    ).pipe(Effect.map((groups) => groups.flat()));
    const prohibited = [
      /us\.i\.posthog\.com/iu,
      /api\.axiom\.co/iu,
      /X-Axiom-Dataset/iu,
      /@sentry\//iu,
      /sentry\.io/iu,
      /crashlytics/iu,
      /bugsnag/iu,
      /@rollbar\//iu,
    ];

    const violations = yield* Effect.forEach(files, (filePath) =>
      fileSystem
        .readFileString(filePath)
        .pipe(
          Effect.map((contents) =>
            prohibited.some((pattern) => pattern.test(contents))
              ? filePath.slice(repoRoot.length + 1)
              : undefined,
          ),
        ),
    ).pipe(Effect.map((paths) => paths.filter((path) => path !== undefined)));

    expect(violations).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps every exporter boundary free of exporter implementations", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repoRoot = yield* path.fromFileUrl(new URL("../../..", import.meta.url));
    const boundaryFiles = [
      ".github/workflows/release.yml",
      "apps/desktop/src/app/DesktopObservability.ts",
      "apps/server/src/observability/BrowserTraceCollector.ts",
      "apps/server/src/observability/Layers/Observability.ts",
      "apps/server/src/telemetry/AnalyticsService.ts",
      "apps/web/src/observability/clientTracing.ts",
      "infra/relay/scripts/deploy.ts",
      "infra/relay/src/observability.ts",
      "packages/shared/src/relayTracing.ts",
    ];
    const prohibited = [
      /OtlpExporter/u,
      /OtlpMetrics/u,
      /OtlpTracer/u,
      /TelemetryLive/u,
      /T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN/u,
      /makeLocalFileTracer/u,
      /makeTraceSink/u,
    ];
    const violations = yield* Effect.forEach(boundaryFiles, (relativePath) =>
      fileSystem
        .readFileString(path.join(repoRoot, relativePath))
        .pipe(
          Effect.map((contents) =>
            prohibited.some((pattern) => pattern.test(contents)) ? relativePath : undefined,
          ),
        ),
    ).pipe(Effect.map((paths) => paths.filter((path) => path !== undefined)));

    expect(violations).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);
