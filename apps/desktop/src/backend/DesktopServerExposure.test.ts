import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";

describe("local desktop exposure", () => {
  it.effect("keeps the server on loopback when remote exposure is requested", () =>
    Effect.gen(function* () {
      const exposure = yield* DesktopServerExposure.DesktopServerExposure;
      yield* exposure.configureFromSettings({ port: 4173 });
      yield* exposure.setMode("network-accessible");
      yield* exposure.setTailscaleServeEnabled({ enabled: true, port: 8443 });
      const config = yield* exposure.backendConfig;
      assert.equal(config.bindHost, "127.0.0.1");
      assert.equal(config.httpBaseUrl.href, "http://127.0.0.1:4173/");
      assert.isFalse(config.tailscaleServeEnabled);
      assert.deepEqual(yield* exposure.getAdvertisedEndpoints, []);
      assert.deepEqual(yield* exposure.getState, {
        mode: "local-only",
        endpointUrl: null,
        advertisedHost: null,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      });
    }).pipe(Effect.provide(DesktopServerExposure.layer)),
  );
});
