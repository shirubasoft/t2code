import { describe, expect, it, vi } from "vite-plus/test";

const { created, updater } = vi.hoisted(() => ({
  created: { listener: undefined as ((session: unknown) => void) | undefined },
  updater: { webRequest: { onBeforeRequest: vi.fn() } },
}));
vi.mock("electron", () => ({
  app: {
    on: (_event: string, listener: (session: unknown) => void) => {
      created.listener = listener;
    },
  },
  session: { fromPartition: () => updater },
}));

import {
  installLocalNetworkPolicy,
  isLocalRendererRequest,
  isReleaseRequest,
  withRequestedUpdateNetwork,
} from "./ElectronNetworkPolicy.ts";

describe("desktop network policy", () => {
  it("rejects external resources and remote files", () => {
    for (const url of [
      "https://example.com",
      "wss://relay.example/ws",
      "http://localhost.example",
      "file://remote/share/icon.png",
    ]) {
      expect(isLocalRendererRequest(url)).toBe(false);
    }
    for (const url of [
      "http://localhost:4000/api",
      "ws://127.0.0.1:4000/ws",
      "t2code://app/",
      "data:image/png;base64,AAA",
    ]) {
      expect(isLocalRendererRequest(url)).toBe(true);
    }
  });
  it("restricts updater requests to the fork's release endpoints", () => {
    expect(isReleaseRequest("https://github.com/shirubasoft/t2code/releases/latest")).toBe(true);
    expect(isReleaseRequest("https://github.com/pingdotgg/t3code/releases/latest")).toBe(false);
    expect(
      isReleaseRequest("https://api.github.com/repos/shirubasoft/t2code/releases/latest"),
    ).toBe(true);
    expect(
      isReleaseRequest("https://api.github.com/repos/shirubasoft/t2code/releases-malicious"),
    ).toBe(false);
  });
  it("permits release traffic only in the updater session during a requested action", async () => {
    installLocalNetworkPolicy();
    created.listener?.(updater);
    const handler = updater.webRequest.onBeforeRequest.mock.calls.at(-1)?.[0] as (
      request: { url: string },
      callback: (result: { cancel: boolean }) => void,
    ) => void;
    const renderer = { webRequest: { onBeforeRequest: vi.fn() } };
    created.listener?.(renderer);
    const rendererHandler = renderer.webRequest.onBeforeRequest.mock.calls.at(
      -1,
    )?.[0] as typeof handler;
    const request = (
      url = "https://github.com/shirubasoft/t2code/releases/latest",
      listener = handler,
    ) => {
      let cancelled = true;
      listener({ url }, ({ cancel }) => {
        cancelled = cancel;
      });
      return cancelled;
    };
    expect(request()).toBe(true);
    await withRequestedUpdateNetwork(async () => {
      expect(request()).toBe(false);
      expect(request("https://release-assets.githubusercontent.com/asset")).toBe(false);
      expect(request("https://example.com/redirect-target")).toBe(true);
      expect(
        request("https://github.com/shirubasoft/t2code/releases/latest", rendererHandler),
      ).toBe(true);
    });
    expect(request()).toBe(true);
    await expect(
      withRequestedUpdateNetwork(async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    expect(request()).toBe(true);
  });
});
