# T2 Code privacy boundary

The local edition permits app-owned network traffic to loopback and connected provider harnesses. Git and fork update operations require a user request. Product analytics, tracking identities, crash delivery, and external trace or metric exporters are removed. Local logs and resource, token, cost, and trace diagnostics remain available.

Provider programs and commands the user runs have their own network behavior. The wrapper's restrictions apply to its own traffic; they do not sandbox arbitrary code launched from a project or provider.

## Reviewing changes to the policy

The trusted guard reads its policy beside its own script, from the accepted commit. A candidate cannot supply a replacement policy. The inventory fingerprints reviewed network/process code, executable build inputs, native sources, package manifests, and the lockfile. Package release versions are normalized; dependency versions and scripts are checked. Critical privacy boundaries and their tests have required hashes. Release builds scan compiled JavaScript, including external dependency code, for prohibited SDKs and collectors.

A maintainer must inspect the behavior of a changed capability before updating `scripts/private-build-policy.json`. Do not refresh hashes merely to make CI pass. Add a regression test when introducing a new boundary. The migration agent cannot change this policy or its trusted controls.

The inventory is a conservative tripwire for known capabilities. It is not proof that arbitrary JavaScript can never communicate. Independent review, loopback transport guards, explicit action scoping, redirect checks, and runtime network smoke tests provide separate checks. Preserve all of them when accepting upstream changes.

## Devbox isolation

The `t2code-devbox` runner uses the `t2code-sync` label and a dedicated service account. Its organization runner group permits only `shirubasoft/t2code/.github/workflows/upstream-sync.yml@refs/heads/main`. A root-owned hook checks the workflow again before accepting a job.

The runner and Codex process have separate filesystem sandboxes. The inner agent starts in an empty directory with shell and web tools disabled. It receives trusted-generated diff and changed-file text as untrusted review material, plus dedicated Codex authentication. Candidate files, the developer's home, homelab credentials, and runner registration credentials are not mounted inside that process.

Candidate builds and tests run on disposable GitHub-hosted runners without repository write credentials or signing secrets. Keep the runner group restricted when editing or reinstalling it. The homelab repository owns its provisioning.

See [releases and upstream updates](release.md) for bootstrap, recovery, and publishing procedures.
