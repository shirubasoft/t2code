import { describe, expect, it } from "vite-plus/test";
import { faviconUrlForOrigin, toolActivityFaviconUrl } from "./favicon.ts";

describe("local favicons", () => {
  it("does not fetch icons for cited websites", () => {
    expect(faviconUrlForOrigin("https://github.com/private/repository")).toBeNull();
    expect(
      toolActivityFaviconUrl(
        { pageUrl: "https://github.com", faviconUrl: "https://icons.example/icon.png" },
        "dark",
      ),
    ).toBeNull();
  });
  it("retains embedded and local preview icons", () => {
    expect(toolActivityFaviconUrl({ pageUrl: "http://localhost:5173/path" }, "light")).toBe(
      "http://localhost:5173/favicon.ico",
    );
    expect(
      toolActivityFaviconUrl(
        { pageUrl: "https://example.com", faviconUrl: "data:image/png;base64,AAAA" },
        "dark",
      ),
    ).toBe("data:image/png;base64,AAAA");
  });
});
