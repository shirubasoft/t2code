import { describe, expect, it } from "vite-plus/test";
import { gitRequiresNetwork, vcsRequiresNetwork } from "./vcsNetworkPolicy.ts";

describe("Git network classification", () => {
  it.each([
    ["commit", "-m", "push"],
    ["status", "--", "clone"],
    ["-C", "fetch", "diff"],
    ["-c", "alias.push=fetch", "status"],
    ["--git-dir", "pull", "log"],
    ["submodule", "status"],
    ["submodule"],
    ["remote", "get-url", "origin"],
    ["remote", "show", "-n", "origin"],
    ["archive", "HEAD"],
    ["--version"],
  ])("allows local arguments %j", (...args) => {
    expect(gitRequiresNetwork(args)).toBe(false);
  });
  it.each([
    ["fetch", "origin"],
    ["-C", "/repo", "pull"],
    ["--git-dir=/repo/.git", "push"],
    ["-c", "protocol.version=2", "clone", "url"],
    ["ls-remote", "origin"],
    ["submodule", "update", "--init"],
    ["submodule", "add", "url"],
    ["submodule", "foreach", "curl example.com"],
    ["remote", "update"],
    ["remote", "show", "origin"],
    ["remote", "add", "-f", "origin", "url"],
    ["remote", "set-head", "origin", "--auto"],
    ["archive", "--remote=origin", "HEAD"],
    ["custom-network-alias"],
  ])("requires a user request for %j", (...args) => {
    expect(gitRequiresNetwork(args)).toBe(true);
  });
  it("recognizes full executable paths and only permits standalone CLI version queries", () => {
    expect(vcsRequiresNetwork("C:\\Program Files\\Git\\git.exe", ["fetch"])).toBe(true);
    expect(vcsRequiresNetwork("/usr/bin/fj", ["whoami"])).toBe(true);
    expect(vcsRequiresNetwork("gh", ["api", "--version"])).toBe(true);
    expect(vcsRequiresNetwork("gh", ["--version"])).toBe(false);
  });
});
