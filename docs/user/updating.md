# Updating T2 Code

T2 Code checks and downloads updates when you request them. Updates come from
[this fork's releases](https://github.com/shirubasoft/t2code/releases/latest).

## Before you update

Updates can restart the local server and interrupt active agents and terminal
commands. Saved threads, settings, and project files remain.

**Settings → General → Continue threads after restarts** is off by default.
Enable it to resume supported active threads after an update, crash, or computer
restart. T2 Code must start again; this setting does not enable automatic startup.
Terminal commands may still be interrupted, and threads without saved provider
resume state need a new message.

## Desktop app

Open **Settings → General → About** and select **Check for Updates**. You can also
use **Check for Updates** in the desktop menu. Download the offered update, then
choose **Install** when you are ready to restart.

Updating the desktop app also updates its bundled server. WSL environments use
the runtime bundled with the desktop app.

If the in-app update fails or is unavailable for your installation, download the
new installer from the fork's release page and follow the
[installation guide](./install.md#desktop-app). Close the running app before
replacing it.

## Command-line server

Run the CLI downloaded from this fork:

```sh
t3 update
```

To choose an exact fork release, use `t3 update <version>`, with the version from
the release page without the tag's leading `v`. The command verifies the
downloaded archive against that release's checksums.

Read the command's final output. It repoints an existing managed launcher when
possible. If you started from a manually extracted archive, run the new
executable at the printed path or update your `t3` launcher to point there.

The command asks before restarting an installed background service. If you
decline, run `t3 service restart` when ready. For a server started by hand, stop
it and start the new executable with your usual local options.

You can also download and extract the latest CLI archive from the fork's release
page. Keep the complete archive contents together, as described in
[Command line](./install.md#command-line).
