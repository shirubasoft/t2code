import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient } from "effect/unstable/http";

import { readCursorUsageLimits } from "./cursorUsageLimits.ts";
import { readGrokUsageLimits } from "./grokUsageLimits.ts";
import { readOpenCodeGoUsageLimits } from "./openCodeUsageLimits.ts";

it.effect("keeps account dashboard probes unavailable without reading credentials or requesting HTTP", () =>
  Effect.gen(function* () {
    let requests = 0;
    let credentialReads = 0;
    const http = HttpClient.make(() => {
      requests += 1;
      return Effect.die("Account dashboard requests are prohibited.");
    });
    const fs = FileSystem.makeNoop({
      readFileString: () => {
        credentialReads += 1;
        return Effect.die("Dashboard probes must not read stored credentials.");
      },
    });
    const probes = [
      readCursorUsageLimits(
        { apiEndpoint: "https://cursor.example/" },
        { CURSOR_AUTH_TOKEN: "test-token", AGENT_CLI_CREDENTIAL_STORE: "file" },
      ),
      readCursorUsageLimits({ apiEndpoint: "" }, { CURSOR_API_KEY: "test-key" }),
      readGrokUsageLimits({
        GROK_AUTH: '{"https://accounts.x.ai/sign-in":{"key":"test-token"}}',
      }),
      readGrokUsageLimits({ GROK_AUTH: "invalid-json", GROK_HOME: "/unused-home" }),
      readOpenCodeGoUsageLimits({
        enabled: true,
        serverUrl: "",
        environment: {
          XDG_DATA_HOME: "/unused-data",
          OPENCODE_AUTH_CONTENT: '{"opencode-go":{"type":"api","key":"test-key"}}',
        },
      }),
      readOpenCodeGoUsageLimits({
        enabled: true,
        serverUrl: "https://remote.example",
        environment: {},
      }),
      readOpenCodeGoUsageLimits({ enabled: false, serverUrl: "", environment: {} }),
    ];
    for (const probe of probes) {
      const limits = yield* probe.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      expect(limits.windows).toEqual([]);
      expect(limits.unavailable).toEqual({ reason: "unsupported" });
      expect(Number.isFinite(Date.parse(limits.checkedAt))).toBe(true);
    }
    expect(requests).toBe(0);
    expect(credentialReads).toBe(0);
  }),
);
