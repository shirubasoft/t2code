# On-demand releases

Release requests are handled in the local Codex task on the maintainer's machine.
The task reviews and adapts the analytics overlay, opens the source update PR,
waits for CI, merges it, and dispatches `release.yml`. GitHub-hosted runners build
and publish Linux packages only, for x64 and ARM64. Keep this release policy
unless the maintainer explicitly changes it. Releases include AppImage and Debian
installers, CLI archives, and Linux updater feeds. No scheduled sync or homelab
runner is required.

## Prepare a source update

Choose the latest published **nightly**, excluding preview releases. Pin its
exact tag for the whole operation. Use separate clean control and candidate
worktrees so assembling the candidate cannot overwrite the accepted controls:

```bash
git fetch origin main
release_work=$(mktemp -d /tmp/t2-release-XXXXXX)
for checkout in control candidate; do
  git worktree add --detach --no-checkout "$release_work/$checkout" origin/main
  git -C "$release_work/$checkout" sparse-checkout set --no-cone '/*' '!/.repos/'
  git -C "$release_work/$checkout" checkout --detach
done
```

From the control worktree, run `plan` with the selected nightly tag:

```bash
cd "$release_work/control"
T2_SYNC_CONTEXT="$release_work/review" node .github/t2code/sync.mjs plan "$nightly_tag"
```

If it prints `release_sha` instead of `ready=true`, finish publishing that
already accepted source before preparing a new update. The planner verifies the
upstream release identity and ancestry. The explicit tag can skip intermediate
nightlies while retaining the complete intervening history for review.

Follow `migrate.md` against the generated review directory and pinned upstream
Git tree. Write the review result as `review/agent-output.json` using
`agent-output.schema.json`. Keep the fixed privacy policy and packaging controls
intact. Run focused checks for any adapted patches.

From the candidate worktree, propose the reviewed snapshot using the control
script:

```bash
cd "$release_work/candidate"
T2_SYNC_CONTEXT="$release_work/review" \
  node "$release_work/control/.github/t2code/sync.mjs" propose
```

This updates the dedicated `codex/analytics-sync` branch and prints the PR number
and candidate SHA. Wait for all checks on that exact SHA and address review
findings. The maintainer merge path uses
`gh pr merge --merge --admin --match-head-commit` after CI passes; do not create a
synthetic `T2 trusted validation` status from the local account.

## Publish and verify

Read the merged PR's `mergeCommit.oid`, then dispatch the hosted release workflow:

```bash
gh workflow run release.yml --repo shirubasoft/t2code --ref main \
  -f "sha=$merged_sha" -f "tag=$nightly_tag"
```

Follow the run through publication. Diagnose failures before retrying; rerun
failed jobs when the evidence shows an external transient failure. Verify the
published installers, CLI archives, checksums, updater manifests and provenance
against the accepted upstream tag and merged commit. Leave any failed release
unpublished until its checks pass.

After publication, remove the temporary worktrees with `git worktree remove`
and keep the main checkout current. Review artifacts are temporary and must not
be committed.
