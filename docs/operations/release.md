# Releases and upstream updates

T2 Code follows `pingdotgg/t3code` main. The hourly upstream workflow maintains one
`codex/upstream-sync` pull request. It merges upstream history, restores the fork's
accepted automation and privacy controls, and asks the isolated devbox Codex runner
to review the diff and propose any necessary repairs. Merge commits preserve upstream
ancestry so later runs only integrate new upstream commits.

The product runs locally without a T2 account or external telemetry. Provider
harness connections, user-requested Git operations, and user-requested update checks
and downloads are permitted. Background update checks and remoting are excluded.
The migration prompt and the accepted privacy policy enforce this boundary.

## Validation and recovery

The repair agent returns bounded file edits. It cannot change `.github`, the privacy
guard, its generated baseline, or protected packaging files. Its read-only shell inspects source
and complete diffs in small sections, including files outside the changed set.
The tool sandbox denies credential access, file writes and networking. Candidate
installation, builds, and tests run on disposable GitHub-hosted workers.

Partial repairs are retained even when the author reports an unresolved obstacle.
The proposed changes are retained in the PR before a fresh, independent agent
reviews the whole diff and every changed capability or dependency. Rejections
include concrete repairs for the next automatic attempt. Only the trusted
controller can record new hashes after approval. The approval is bound to every
tracked source file and its mode, the accepted base, and the trusted workflow run.
CI verifies the successful reviewer job and its immutable approval artifact before
accepting the generated baseline. Editing a baseline cannot approve its contents.

Validation is dispatched from `main` with the exact candidate and accepted base
commit IDs. The accepted guard checks the candidate before ordinary CI runs. A
separate merger checks the successful workflow, all required jobs, the PR head, and
the unchanged base before merging that exact head. It does not bypass branch rules.

A failed migration is retried each hour with previous failure logs and the last
proposed candidate. A tracking issue records failures without pausing retries and
closes when an update merges. Large diffs are stored on disk for the agent to read
as needed. Each job has a time limit; the next scheduled run continues repairs.
Successful validation is reused when a merge needs retrying. The hourly workflow
also retries missing or failed releases for the accepted main commit, while
allowing active builds to finish and skipping commits already published.

Changes to implementation hashes are reviewed and accepted automatically. The
fixed product policy, privacy boundaries, guards and release controls stay
protected. The Git command classifier is a reviewed adapter: it can accommodate
new local commands under independent review while its privacy regressions remain
fixed. New upstream tests that expect prohibited external behavior must instead
assert the local result and denied requests. Failed review or validation leaves the accepted release available
while the repair loop continues.

## Publishing installers

Merges to `main` publish a release after source checks, lint, typechecking, tests,
and all platform builds pass. The automated merger explicitly dispatches the
release workflow for the returned merge commit. To retry a failed release before
the next hourly check, dispatch **Release** from `main` with the full merged commit
SHA. A SHA already published is skipped. Versions use `0.1.<release workflow run number>`.

Each release contains macOS DMGs, Linux AppImages, and Windows installers for
both x64 and arm64, plus standalone CLI archives for macOS arm64, Linux x64/arm64,
and Windows x64/arm64. macOS x64 uses the desktop app; upstream's Node
single-executable packaging does not support that CLI target. Linux CLI and desktop
smoke tests run with only loopback networking and reject external requests or
packet transmissions. The desktop check uses a fresh profile, completes local onboarding,
and opens Settings before an installer can be published.

`SHA256SUMS` covers the attached files. `provenance.json` identifies the exact fork
commit and, for automated syncs, the upstream commit. Update feeds reference only
attached assets and their sizes and SHA-512 hashes are checked before publication.
The desktop checks this fork's releases only when the user requests an update.

Builds are currently unsigned. macOS and Windows can require an installation
override. Signing requires separate platform credentials and a trusted signing
stage; the repair agent has no signing credentials.

## Repository setup

Enable Actions to create pull requests. Protect `main` with required validation
and require review for changes to the trusted policy and workflows. Do not require
linear history or squash upstream integration PRs. The automation uses scoped job
tokens and explicit workflow dispatches. The devbox's separate fallback dispatcher
covers missing scheduled runs; its credential is kept outside the agent runner.

The devbox runner belongs to the selected-repository organization group
`t2code-sync`. Restrict that group to
`shirubasoft/t2code/.github/workflows/upstream-sync.yml@refs/heads/main` and retain
its host-side workflow check. The homelab repository owns its provisioning and
service configuration.

Maintainer changes to protected controls require review and full CI. Dispatch CI
from the reviewed branch with its exact commit as both source and base, then merge
that reviewed commit. This procedure also establishes the initial policy. The
automatic merger accepts only validation dispatched from the accepted `main`
workflow; it cannot use the maintainer procedure to approve its own controls.
