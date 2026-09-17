# T2 Code privacy boundary

The local edition permits app-owned network traffic to loopback and connected provider harnesses. Git and fork update operations require a user request. Product analytics, tracking identities, crash delivery, and external trace or metric exporters are removed. Local logs and resource, token, cost, and trace diagnostics remain available.

Provider programs and commands the user runs have their own network behavior. The wrapper's restrictions apply to its own traffic; they do not sandbox arbitrary code launched from a project or provider.

## Reviewing changes to the policy

The trusted guard reads its policy beside its own script, from the accepted commit. A candidate cannot supply a replacement policy. The inventory fingerprints reviewed network/process code, executable build inputs, native sources, dependency patches, package manifests, and the lockfile. Package release versions are normalized; dependency versions and scripts are checked. Critical privacy boundaries and their tests have required hashes. Installer and CLI staging use frozen dependency closures from that reviewed lockfile, including transitive and optional platform packages. Release builds scan compiled JavaScript, including external dependency code, for prohibited SDKs and collectors.

The independent privacy reviewer inspects changed capabilities before the trusted controller updates `scripts/private-build-baseline.json`. CI verifies approval for the exact source tree and accepted base. Hashes are never refreshed merely to make CI pass. Fixed boundaries in `scripts/private-build-policy.json` remain protected, including their regression tests. The repair agent cannot edit either file or its trusted controls. The policy also
lists reviewed adapters whose implementation can evolve under independent review.
Their hashes are always checked, even when the code contains no network calls,
and their protected privacy tests remain unchanged.

The inventory is a conservative tripwire for known capabilities. It is not proof that arbitrary JavaScript can never communicate. Independent review, loopback transport guards, explicit action scoping, redirect checks, and runtime network smoke tests provide separate checks. Preserve all of them when accepting upstream changes.

## Devbox isolation

The `t2code-devbox` runner uses the `t2code-sync` label and a dedicated service account. Its organization runner group permits only `shirubasoft/t2code/.github/workflows/upstream-sync.yml@refs/heads/main`. A root-owned hook checks the workflow again before accepting a job.

The runner and Codex process have separate filesystem sandboxes. Each agent starts in an empty directory with read-only source and review material. Its shell can inspect that material but cannot write files, use the network, or read authentication and output files. The parent Codex process uses a dedicated login to return structured results. The developer's home, homelab credentials, and runner registration credentials are outside its mounts.

Candidate builds and tests run on disposable GitHub-hosted runners without repository write credentials or signing secrets. Keep the runner group restricted when editing or reinstalling it. The homelab repository owns its provisioning.

See [releases and upstream updates](release.md) for bootstrap, recovery, and publishing procedures.
