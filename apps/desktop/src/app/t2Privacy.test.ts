import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import { vi } from "vite-plus/test";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopObservability from "./DesktopObservability.ts";

it.effect("keeps desktop traces local with an external exporter configured", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t2-desktop-privacy-" });
    const environment = DesktopEnvironment.layer({
      dirname: "/repo/apps/desktop/dist-electron",
      homeDirectory: baseDir,
      platform: "linux",
      processArch: "x64",
      appVersion: "0.1.1",
      appPath: "/repo",
      isPackaged: false,
      resourcesPath: "/repo/resources",
      runningUnderArm64Translation: false,
    }).pipe(
      Layer.provide(
        DesktopConfig.layerTest({
          T3CODE_HOME: baseDir,
          VITE_DEV_SERVER_URL: "http://127.0.0.1:5733",
          T3CODE_OTLP_TRACES_URL: "https://collector.invalid/v1/traces",
        }),
      ),
    );
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const tracePath = yield* Effect.gen(function* () {
      const env = yield* DesktopEnvironment.DesktopEnvironment;
      return env.path.join(env.logDir, "desktop.trace.ndjson");
    }).pipe(Effect.provide(environment));
    yield* Effect.scoped(
      Effect.void.pipe(
        Effect.withSpan("enterprise-source", { attributes: { code: "company secret" } }),
        Effect.provide(
          DesktopObservability.layer.pipe(
            Layer.provide(environment),
            Layer.provide(
              FetchHttpClient.layer.pipe(
                Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)),
              ),
            ),
          ),
        ),
      ),
    );
    expect(fetchFn).not.toHaveBeenCalled();
    expect(yield* fs.readFileString(tracePath)).toContain("company secret");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
