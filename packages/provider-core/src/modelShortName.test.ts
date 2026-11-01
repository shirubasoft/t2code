import { describe, expect, it } from "vite-plus/test";

import { modelShortName } from "./modelShortName.ts";

describe("modelShortName", () => {
  it.each([
    ["Claude Opus 5.5", ["Claude "], "Opus 5.5"],
    ["GPT-6.1-Sol", ["GPT-"], "6.1 Sol"],
    ["GPT 6.0 Astra", ["GPT-", "GPT "], "6.0 Astra"],
    ["Grok 4 Pro", [], undefined],
    ["Claude Opus 5.5", [], "Opus 5.5"],
    ["NVIDIA: Nemotron 3 Super", [], "Nemotron 3 Super"],
    ["GPT-5.5", ["GPT-"], undefined],
    ["Gemini 3.1 Pro", ["Gemini "], "3.1 Pro"],
  ] as const)("gives %s on families %j the short name %s", (name, families, expected) => {
    expect(modelShortName(name, families)).toBe(expected);
  });

  it.each([
    ["3.1 (thinking)", undefined],
    ["3.1 (thinking) Pro", "3.1 (thinking) Pro"],
    ["3.1 (Pro (preview))", "3.1 (Pro (preview))"],
    ["3.1 (Pro\n)", "3.1 (Pro\n)"],
    ["3.1 (Pro\r)", "3.1 (Pro\r)"],
    ["3.1 (Pro\u2028)", "3.1 (Pro\u2028)"],
    ["3.1 (Pro\u2029)", "3.1 (Pro\u2029)"],
  ])("preserves parenthetical label behavior for %j", (suffix, expected) => {
    expect(modelShortName(`Gemini ${suffix}`, ["Gemini "])).toBe(expected);
  });

  it("retains long unmatched annotations", () => {
    const suffix = `3.1 ${"(".repeat(8_000)}`;
    expect(modelShortName(`Gemini ${suffix}`, ["Gemini "])).toBe(suffix);
  });
});
