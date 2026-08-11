import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  hasDeployChanges,
  missingRelayPublicConfigFields,
  publicConfigFromOutput,
  reconcileRootEnvPublicConfig,
  reconcileRootEnvRelayUrl,
  RelayDeployError,
  serializeGithubOutput,
} from "./deploy.ts";

describe("RelayDeployError", () => {
  it("reports the incomplete state source, stage, and missing fields", () => {
    const missingFields = missingRelayPublicConfigFields({});
    const error = new RelayDeployError({
      source: "alchemy_state",
      stage: "production",
      missingFields,
    });

    expect(error).toMatchObject({
      source: "alchemy_state",
      stage: "production",
      missingFields: ["url"],
    });
    expect(error.message).toBe(
      "Relay deploy output from 'alchemy_state' for stage 'production' is missing required public config fields: url",
    );
  });
});

describe("hasDeployChanges", () => {
  it("detects resource, binding, and deletion changes", () => {
    expect(hasDeployChanges({ resources: {}, deletions: {} } as never)).toBe(false);
    expect(
      hasDeployChanges({
        resources: {
          api: { action: "create", bindings: [] },
        },
        deletions: {},
      } as never),
    ).toBe(true);
    expect(
      hasDeployChanges({
        resources: {
          api: { action: "noop", bindings: [{ action: "update" }] },
        },
        deletions: {},
      } as never),
    ).toBe(true);
    expect(
      hasDeployChanges({
        resources: {},
        deletions: {
          api: { action: "delete", bindings: [] },
        },
      } as never),
    ).toBe(true);
  });
});

describe("reconcileRootEnvRelayUrl", () => {
  it("adds the relay URL to an empty root env file", () => {
    expect(reconcileRootEnvRelayUrl("", "https://relay.example.test")).toBe(
      "T3CODE_RELAY_URL=https://relay.example.test\n",
    );
  });

  it("preserves unrelated root env entries while replacing a previous relay URL", () => {
    expect(
      reconcileRootEnvRelayUrl(
        "T3CODE_CLERK_PUBLISHABLE_KEY=pk_test_example\nT3CODE_RELAY_URL=https://old.example.test\n",
        "https://relay.example.test",
      ),
    ).toBe(
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_test_example\nT3CODE_RELAY_URL=https://relay.example.test\n",
    );
  });
});

describe("reconcileRootEnvPublicConfig", () => {
  const config = { relayUrl: "https://relay.example.test" } as const;

  it("adds the relay URL without tracing credentials", () => {
    expect(reconcileRootEnvPublicConfig("", config)).toBe(
      "T3CODE_RELAY_URL=https://relay.example.test\n",
    );
  });

  it("replaces stale relay URLs while preserving unrelated entries", () => {
    expect(
      reconcileRootEnvPublicConfig(
        "T3CODE_CLERK_PUBLISHABLE_KEY=pk_test_example\nT3CODE_RELAY_URL=https://old.example.test\n",
        config,
      ),
    ).toBe(
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_test_example\nT3CODE_RELAY_URL=https://relay.example.test\n",
    );
  });
});

describe("serializeGithubOutput", () => {
  it("serializes relay deploy metadata for GitHub Actions outputs", () => {
    expect(
      serializeGithubOutput({
        changed: false,
        result: "noop",
        relay_url: "https://relay.example.test",
      }),
    ).toBe("changed=false\nresult=noop\nrelay_url=https://relay.example.test\n");
  });
});

describe("release workflow telemetry policy", () => {
  it.effect("does not propagate tracing credentials", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workflowPath = yield* path.fromFileUrl(
        new URL("../../../.github/workflows/release.yml", import.meta.url),
      );
      const workflow = yield* fileSystem.readFileString(workflowPath);

      expect(workflow).not.toContain("relay-client-tracing-config");
      expect(workflow).not.toContain("T3CODE_RELAY_CLIENT_OTLP_TRACES_");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("publicConfigFromOutput", () => {
  it("reads the relay URL from persisted Alchemy output", () => {
    expect(publicConfigFromOutput({ url: "https://relay.example.test" })).toEqual({
      relayUrl: "https://relay.example.test",
    });
  });

  it("rejects incomplete stack output", () => {
    expect(publicConfigFromOutput({})).toBeNull();
  });
});
