#!/usr/bin/env bash
set -euo pipefail
[[ $# == 1 ]] || exit 2
appimage=$(realpath "$1")
repo=$(pwd)
node_path=$(command -v node)
smoke_dir=$(mktemp -d)
evidence="$repo/desktop-smoke-evidence"
mkdir -p "$evidence" "$smoke_dir/home" "$smoke_dir/runtime" "$smoke_dir/extracted"
chmod 700 "$smoke_dir/runtime"
trap 'rm -rf "$smoke_dir"' EXIT

# A fresh profile catches Chromium services that never run again after their
# first download. No credentials, proxies or developer settings enter this run.
# Trace denied requests too; an offline fallback must not hide an egress attempt.
sudo -n timeout --kill-after=10s 120s unshare --net --pid --fork --kill-child --mount-proc -- /bin/bash -s -- \
  "$node_path" "$appimage" "$smoke_dir" "$evidence" "$repo" "$(id -un)" <<'SMOKE'
set -euo pipefail
ip link set lo up
trap 'exit 143' TERM
mkfifo "$3/result"
chown "$6" "$3/result"
chmod 600 "$3/result"
runuser -u "$6" -- env -i \
  HOME="$3/home" XDG_CONFIG_HOME="$3/home/.config" XDG_DATA_HOME="$3/home/.local/share" \
  XDG_CACHE_HOME="$3/home/.cache" XDG_RUNTIME_DIR="$3/runtime" \
  PATH="$(dirname "$1"):/usr/bin:/bin" LANG=C.UTF-8 \
  strace -f -qq -yy -s 512 \
  -e trace=network,write,writev,sendfile,splice,vmsplice,close,dup,dup2,dup3,fcntl \
  -o "$4/network.strace" /bin/bash -s -- "$1" "$2" "$3" "$4" "$5" <<'DESKTOP' &
set -euo pipefail
trap 'status=$?; if [[ -d "$HOME/.t2/userdata/logs" ]]; then mkdir -p "$4/runtime-logs"; cp -a "$HOME/.t2/userdata/logs/." "$4/runtime-logs/" || true; fi; printf "%s\n" "$status" > "$3/result"' EXIT
cd "$3/extracted"
"$2" --appimage-extract > "$4/extraction.log"
xvfb-run --auto-servernum --server-args='-screen 0 1280x900x24 -nolisten tcp' \
  "$1" "$5/.github/t2code/desktop-smoke.mjs" "$3/extracted/squashfs-root/t2code" "$4"
DESKTOP
# The helper's exit receipt is independent of strace waiting for detached
# backend descendants. Exiting this private PID namespace's init kills only
# this smoke test's remaining processes, including processes that call setsid.
read -r result < "$3/result"
exit "$result"
SMOKE
node .github/t2code/verify-network-trace.mjs "$evidence/network.strace"
