import { describe, expect, it } from "vite-plus/test";

import { isLoopbackUrl } from "./localNetwork.ts";

describe("local network boundary", () => {
  it.each(["http://127.0.0.1:3773", "ws://localhost:3773/ws", "https://[::1]:8080"])(
    "permits local transport %s",
    (url) => expect(isLoopbackUrl(url)).toBe(true),
  );

  it.each([
    "https://example.com",
    "https://localhost.example.com",
    "https://192.168.0.1",
    "https://localhost@evil.example",
    "https://user:secret@localhost",
    "file:///etc/passwd",
    "https://[::ffff:192.168.0.1]",
    "not a URL",
  ])("rejects external or ambiguous transport %s", (url) => {
    expect(isLoopbackUrl(url)).toBe(false);
  });
});
