# Install T2 Code

Download T2 Code from [this fork's releases](https://github.com/shirubasoft/t2code/releases/latest).
It runs locally without a T2 Code account. Provider authentication belongs to the
provider you choose.

The `t3.codes` install scripts, `npx t3`, and T3 Code package-manager entries
install the upstream product. Use this fork's release assets to install T2 Code.

## Desktop app

Choose the installer matching your operating system and processor. In these
filenames, `<version>` is the release version. Replace `<arch>` with `arm64` for
Apple Silicon or an ARM PC, or `x64` for an Intel or AMD processor.

| Platform            | Release asset                       | Install                                            |
| ------------------- | ----------------------------------- | -------------------------------------------------- |
| macOS               | `T2-Code-<version>-<arch>.dmg`      | Open the DMG and copy T2 Code to Applications.     |
| Windows             | `T2-Code-<version>-<arch>.exe`      | Run the installer.                                 |
| Linux, Intel or AMD | `T2-Code-<version>-x86_64.AppImage` | Mark the downloaded file executable, then open it. |
| Linux, ARM          | `T2-Code-<version>-arm64.AppImage`  | Mark the downloaded file executable, then open it. |

For Linux, you can set the executable permission in the file manager or run
`chmod +x` followed by the downloaded AppImage's path.

Builds are unsigned. macOS and Windows may require an operating-system approval
before opening the app. Each release includes `SHA256SUMS` and `provenance.json`
for checking the download and its source commit.

Launch the app to finish local setup. Install and authenticate a provider before
starting a thread; you can configure providers after opening T2 Code.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects
there. Install provider CLIs inside that distro. The desktop app installs its
bundled server runtime there automatically; the first launch after an app update
can take longer.

## Command line

The same release page provides standalone CLI archives:

| Platform             | Release asset                      |
| -------------------- | ---------------------------------- |
| macOS, Apple Silicon | `t3-<version>-darwin-arm64.tar.gz` |
| Linux                | `t3-<version>-linux-<arch>.tar.gz` |
| Windows              | `t3-<version>-win32-<arch>.zip`    |

The CLI command is `t3`. Download these archives from `shirubasoft/t2code` to get
this edition. Use the desktop DMG on Intel Macs.

Extract the entire archive and open its `t3-<version>-<platform>-<arch>`
directory. Keep `t3` (or `t3.exe`) with the archive's other files. Run `./t3` from
that directory on macOS or Linux, or `.\t3.exe` in PowerShell. Add the directory
to your `PATH` to use the commands below from another directory.

| Task                                                | Command                                |
| --------------------------------------------------- | -------------------------------------- |
| Start the local server and open the web app         | `t3`                                   |
| Start the local server without a browser            | `t3 serve`                             |
| Keep it running in the background on macOS or Linux | `t3 service install`                   |
| Download a newer fork release                       | `t3 update` ([details](./updating.md)) |
| Remove a managed CLI installation                   | `t3 uninstall`                         |

Run `t3 --help` for the full command reference. For a manually extracted archive,
remove its directory when you no longer need it.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
t3 app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `t3 app ../my-project`, to open another directory. If the
command cannot reach the app, start or update the desktop app and try again.

## Connection support

This edition supports the local desktop or web client and local WSL environments.
The App Store and Google Play listings distribute upstream T3 Code. Remote
environments and T3 Connect are unavailable in this edition.

## Providers

Open **Settings → Providers** in the web or desktop app and enable the provider
you want. Install and authenticate providers on the computer where they run, or
inside the selected WSL distro.

| Provider    | Install and authenticate                                                                     |
| ----------- | -------------------------------------------------------------------------------------------- |
| Codex       | Install [Codex CLI](https://developers.openai.com/codex/cli), then run `codex login`.        |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`. |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                        |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                           |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                     |
| Antigravity | Install and sign in with Google from T2 Code's provider settings.                            |

Provider CLIs must be on the server's `PATH`. If T2 Code cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Antigravity can use its managed runtime without a `PATH` entry.

Update provider CLIs with the installer you used. When **Update now** is
available on a provider card, it runs that provider's installer after you request
it.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, T2 Code does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md), and
[Antigravity](./providers-antigravity.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Updating T2 Code](./updating.md): update the desktop app or CLI.
