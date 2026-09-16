# T2 Code

T2 Code is a local edition of [T3 Code](https://github.com/pingdotgg/t3code). It keeps the desktop coding-agent workspace and removes hosted account login, product analytics, tracking identities, crash delivery, and external telemetry exporters.

Download an installer from [Releases](https://github.com/shirubasoft/t2code/releases/latest):

- macOS: DMG for Apple Silicon or Intel.
- Windows: installer for x64 or ARM64.
- Linux: AppImage for x64 or ARM64. Mark it executable before launching.

The initial builds are unsigned. macOS and Windows may require an operating-system approval before opening them. Release assets include SHA-256 checksums and the source commit used to build them.

No T2 Code account is required. Connect an installed provider such as Codex, Claude Code, Cursor, Grok, OpenCode, or Antigravity using that provider's own credentials. Provider services and commands you run retain their own network behavior.

The app connects to its local server and provider harnesses. Git operations and update checks/downloads run when requested. Updates come from this fork's releases. Local resource, token, cost, and trace diagnostics remain available. Model metadata and pricing are bundled, so reading them does not fetch a remote catalog. The desktop uses separate T2 Code application data.

Remote environments, SSH devices, cloud relay, hosted login, remote theme discovery, and background network polling are excluded from this edition. Local themes, local previews, and WSL remain available.

An hourly GitHub workflow checks upstream main. A Codex agent on an isolated devbox runner reviews the merge and proposes repairs. Independent GitHub-hosted checks validate the exact candidate against the accepted privacy policy before merging. A successful merge builds installers. Changes that require new network capabilities or changes to the policy stop for maintainer review; the last working release remains available.

For development, install with `vp install` and start with `vp run dev`. See [development](docs/operations/development.md) and [operating the fork](docs/operations/t2code.md).

T2 Code retains the upstream license and attribution. It is an independent fork.
