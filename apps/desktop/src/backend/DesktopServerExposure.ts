import {
  type AdvertisedEndpoint,
  type DesktopServerExposureMode,
  type DesktopServerExposureState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

const DESKTOP_LOOPBACK_HOST = "127.0.0.1";

export interface DesktopServerExposureBackendConfig {
  readonly port: number;
  readonly bindHost: string;
  readonly httpBaseUrl: URL;
  readonly tailscaleServeEnabled: boolean;
  readonly tailscaleServePort: number;
}

export interface DesktopServerExposureChange {
  readonly state: DesktopServerExposureState;
  readonly requiresRelaunch: boolean;
}

export class DesktopServerExposure extends Context.Service<
  DesktopServerExposure,
  {
    readonly getState: Effect.Effect<DesktopServerExposureState>;
    readonly backendConfig: Effect.Effect<DesktopServerExposureBackendConfig>;
    readonly configureFromSettings: (input: {
      readonly port: number;
    }) => Effect.Effect<DesktopServerExposureState>;
    readonly setMode: (
      mode: DesktopServerExposureMode,
    ) => Effect.Effect<DesktopServerExposureChange>;
    readonly setTailscaleServeEnabled: (input: {
      readonly enabled: boolean;
      readonly port?: number;
    }) => Effect.Effect<DesktopServerExposureChange>;
    readonly getAdvertisedEndpoints: Effect.Effect<readonly AdvertisedEndpoint[]>;
  }
>()("@t3tools/desktop/backend/DesktopServerExposure") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const port = yield* Ref.make(0);
  const state: DesktopServerExposureState = {
    mode: "local-only",
    endpointUrl: null,
    advertisedHost: null,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  };
  return DesktopServerExposure.of({
    getState: Effect.succeed(state),
    backendConfig: Ref.get(port).pipe(
      Effect.map((port) => ({
        port,
        bindHost: DESKTOP_LOOPBACK_HOST,
        httpBaseUrl: new URL(`http://${DESKTOP_LOOPBACK_HOST}:${port}`),
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      })),
    ),
    configureFromSettings: (input) => Ref.set(port, input.port).pipe(Effect.as(state)),
    setMode: () => Effect.succeed({ state, requiresRelaunch: false }),
    setTailscaleServeEnabled: () => Effect.succeed({ state, requiresRelaunch: false }),
    getAdvertisedEndpoints: Effect.succeed([]),
  });
});

export const layer = Layer.effect(DesktopServerExposure, make);
