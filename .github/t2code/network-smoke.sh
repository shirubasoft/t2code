#!/usr/bin/env bash
set -euo pipefail
[[ $# == 2 ]] || exit 2
trace=$(mktemp)
trap 'rm -f "$trace"' EXIT
# Resolve Vite+ or other version-manager shims before entering the isolated
# profile, where they cannot download a runtime or use the runner's cache.
node_path=$(node -p 'process.execPath')

# The archive executes as the ordinary runner user in a fresh network namespace.
# Only loopback exists. strace records attempted destinations, including denied
# requests, so an offline fallback cannot conceal background telemetry.
sudo -n unshare --net -- /bin/bash -s -- "$node_path" "$1" "$2" "$trace" "$PWD" "$(id -un)" <<'SMOKE'
set -euo pipefail
ip link set lo up
cd "$5"
exec runuser -u "$6" -- timeout 90 strace -f -qq -yy -s 256 \
  -e trace=network,write,writev,sendfile,splice,vmsplice,close,dup,dup2,dup3,fcntl -o "$4" \
  "$1" scripts/smoke-cli-archive.ts --archive "$2" --expect-version "$3"
SMOKE
node .github/t2code/verify-network-trace.mjs "$trace"
