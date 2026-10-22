import { assert, describe, it } from "@effect/vitest";

import * as GitCafeHosts from "./gitCafeHosts.ts";

describe("gitCafeHosts", () => {
  it("rejects long interior slash runs and accepts trailing slashes after a repository", () => {
    const slashes = "/".repeat(20_000);
    assert.isNull(GitCafeHosts.gitCafeRepositoryPath(`team/${slashes}project`));
    assert.strictEqual(
      GitCafeHosts.gitCafeRepositoryPath(`team/project.git${slashes}`),
      "team/project",
    );
    assert.isNull(GitCafeHosts.gitCafeRepositoryPath(slashes));
  });

  it("knows exactly the production and staging hosts", () => {
    assert.deepStrictEqual([...GitCafeHosts.GITCAFE_HOSTS], ["git.cafe", "staging.git.cafe"]);
    assert.isTrue(GitCafeHosts.isGitCafeHost("Git.Cafe"));
    assert.isTrue(GitCafeHosts.isGitCafeHost("staging.git.cafe"));
    for (const host of ["cafe", "evil.git.cafe", "git.cafe.example.com", "github.com"]) {
      assert.isFalse(GitCafeHosts.isGitCafeHost(host), host);
    }
  });

  it.each([
    ["https://staging.git.cafe/team/project.git/", "staging.git.cafe"],
    ["ssh@git.cafe:team/project.git", "git.cafe"],
    ["ssh://git@git.cafe/team/project.git", "git.cafe"],
  ])("reads the host and repository of %s", (url, host) => {
    assert.deepStrictEqual(GitCafeHosts.parseGitCafeRemote(url), {
      host,
      repository: "team/project",
    });
  });

  it.each([
    "https://evil.git.cafe/team/project.git",
    "https://git.cafe/team/nested/project.git",
    "team/project",
  ])("is not a GitCafe repository: %s", (url) => {
    assert.isNull(GitCafeHosts.parseGitCafeRemote(url));
  });
});
