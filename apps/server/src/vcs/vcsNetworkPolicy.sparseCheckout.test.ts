import { describe, expect, it } from "vite-plus/test";

import { gitRequiresNetwork, vcsRequiresNetwork } from "./vcsNetworkPolicy.ts";

describe("local sparse checkout classification", () => {
  it.each([
    ["sparse-checkout", "init", "--cone"],
    ["sparse-checkout", "set", "src"],
    ["sparse-checkout", "add", "packages"],
    ["sparse-checkout", "list"],
    ["sparse-checkout", "reapply"],
    ["sparse-checkout", "disable"],
    ["sparse-checkout", "check-rules", "-z"],
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "sparse.expectFilesOutsideOfPatterns=false",
      "sparse-checkout",
      "check-rules",
      "-z",
    ],
  ])("permits local command %j", (...args) => {
    expect(gitRequiresNetwork(args)).toBe(false);
    expect(vcsRequiresNetwork("git", args)).toBe(false);
    expect(vcsRequiresNetwork("C:\\Git\\bin\\git.exe", args)).toBe(false);
  });

  it.each([
    ["fetch", "origin"],
    ["push", "origin", "HEAD"],
    ["pull"],
    ["sparse-checkout-custom-helper", "check-rules"],
    ["-c", "alias.sparse-helper=!curl https://example.test", "sparse-helper"],
    ["-C", "sparse-checkout", "fetch", "origin"],
  ])("still requires an explicit network grant for %j", (...args) => {
    expect(gitRequiresNetwork(args)).toBe(true);
  });
});
