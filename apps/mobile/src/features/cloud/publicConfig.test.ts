import { describe, expect, it, vi } from "vite-plus/test";

import {
  CloudPublicConfigMissingError,
  hasCloudPublicConfig,
  resolveCloudPublicConfig,
  resolveRelayClerkTokenOptions,
} from "./publicConfig";

vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));

describe("resolveCloudPublicConfig", () => {
  it("reports cloud authentication as unavailable", () => {
    expect(hasCloudPublicConfig()).toBe(false);
    expect(() => resolveRelayClerkTokenOptions()).toThrowError(
      new CloudPublicConfigMissingError({ key: "T3CODE_CLERK_JWT_TEMPLATE" }),
    );
  });

  it("cannot enable hosted services or exporters with old build configuration", () => {
    expect(
      resolveCloudPublicConfig({
        clerk: { publishableKey: "pk_test_example", jwtTemplate: "t3-relay" },
        relay: { url: "https://relay.example.test" },
        observability: {
          tracesUrl: "https://collector.example.test/v1/traces",
          tracesDataset: "mobile-traces",
          tracesToken: "public-ingest-token",
        },
      }),
    ).toEqual({
      clerk: { publishableKey: null, jwtTemplate: null },
      relay: { url: null },
      observability: { tracesUrl: null, tracesDataset: null, tracesToken: null },
    });
  });
});
