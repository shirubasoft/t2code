import * as NodeFS from "node:fs";
const { readFileSync } = NodeFS;
import * as NodePath from "node:path";
const { resolve } = NodePath;
import * as NodeURL from "node:url";
const { pathToFileURL } = NodeURL;

function completedCalls(trace) {
  const calls = [];
  const pending = new Map();
  for (const line of trace.split("\n")) {
    const resumed = line.match(/^(\d+)\s+<\.\.\. (\w+) resumed>(.*)$/);
    const previous = resumed && pending.get(resumed[1]);
    if (previous && previous.operation === resumed[2]) {
      calls[previous.index] =
        calls[previous.index].replace(/\s*<unfinished \.\.\.>$/, "") + resumed[3];
      pending.delete(resumed[1]);
      continue;
    }
    const unfinished = line.match(/^(\d+)\s+(\w+)\(.*<unfinished \.\.\.>$/);
    if (unfinished) pending.set(unfinished[1], { index: calls.length, operation: unfinished[2] });
    calls.push(line);
  }
  return calls;
}

function packetlessRouteProbes(calls) {
  const sockets = new Map();
  const descriptors = new Map();
  const boundUses = new Map();
  for (const [index, line] of calls.entries()) {
    // strace replaces the inode with a local endpoint after UDP autobinds, even
    // if connect fails. Only a close on the same thread/descriptor may establish
    // that transition; every use of the resulting endpoint is checked below.
    for (const [, label] of line.matchAll(/"(?:\\.|[^"\\])*"|\d+<(UDPv6:\[\[::\]:\d+\])>/g)) {
      if (!label) continue;
      const uses = boundUses.get(label) ?? [];
      uses.push(index);
      boundUses.set(label, uses);
    }
    const allocated = line.match(/^(\d+)\s+socket\(.*\)\s+= (\d+)</);
    if (allocated) {
      const key = `${allocated[1]}:${allocated[2]}`;
      const previous = descriptors.get(key);
      if (previous && !previous.closed) previous.valid = false;
      descriptors.delete(key);
    }
    const created = line.match(
      /\bsocket\(AF_INET6, SOCK_DGRAM(?:\|SOCK_(?:CLOEXEC|NONBLOCK))*, IPPROTO_(?:IP|UDP)\)\s+= \d+<UDPv6:\[(\d+)\]>/,
    );
    if (created) {
      const socket = {
        valid: !sockets.has(created[1]),
        closed: false,
        probe: undefined,
        inode: created[1],
        boundLabel: undefined,
        closeIndex: undefined,
      };
      sockets.set(created[1], socket);
      if (allocated) descriptors.set(`${allocated[1]}:${allocated[2]}`, socket);
      continue;
    }
    const operated = line.match(/^(\d+)\s+(\w+)\((\d+)<([^>]+)>/);
    if (operated) {
      const socket = descriptors.get(`${operated[1]}:${operated[3]}`);
      if (socket && !socket.closed && operated[4] !== `UDPv6:[${socket.inode}]`) {
        if (
          socket.probe !== undefined &&
          /^\d+\s+close\(\d+<UDPv6:\[\[::\]:\d+\]>\)\s+= 0\b/.test(line)
        ) {
          socket.boundLabel = operated[4];
          socket.closeIndex = index;
          socket.closed = true;
        } else {
          socket.valid = false;
        }
      }
    }
    for (const [, inode] of line.matchAll(/<UDPv6:\[(\d+)\]>/g)) {
      const socket = sockets.get(inode);
      if (!socket) continue;
      if (socket.closed) {
        socket.valid = false;
      } else if (
        /\bconnect\(\d+<UDPv6:\[\d+\]>, \{sa_family=AF_INET6, sin6_port=htons\(443\), sin6_flowinfo=htonl\(0\), inet_pton\(AF_INET6, "2001:4860:4860::8888", &sin6_addr\), sin6_scope_id=0\}, 28\)\s+= -1 ENETUNREACH\b/.test(
          line,
        )
      ) {
        if (socket.probe !== undefined) socket.valid = false;
        socket.probe = index;
        if (operated) descriptors.set(`${operated[1]}:${operated[3]}`, socket);
      } else if (/\bclose\(\d+<UDPv6:\[\d+\]>\)\s+= 0\b/.test(line)) {
        socket.closed = true;
      } else if (!/\bfcntl\(\d+<UDPv6:\[\d+\]>, F_(?:GETFL|SETFL|GETFD|SETFD)\b/.test(line)) {
        // Any send/write, descriptor duplication, or unknown use fails closed.
        socket.valid = false;
      }
    }
  }
  // Chromium 152's HostResolverManager::StartGloballyReachableCheck uses a
  // UDP connect only to consult the route table; it never sends a packet.
  // Require the full socket lifetime, an unreachable route, and no transmission,
  // rather than exempting any traffic to this address. Capture with strace -yy.
  // https://github.com/chromium/chromium/blob/152.0.7977.65/net/dns/host_resolver_manager.cc#L1624
  return new Set(
    [...sockets.values()]
      .filter(
        (socket) =>
          socket.valid &&
          socket.closed &&
          socket.probe !== undefined &&
          (!socket.boundLabel ||
            boundUses.get(socket.boundLabel)?.every((index) => index === socket.closeIndex)),
      )
      .map((socket) => socket.probe),
  );
}

export function unexpectedConnections(trace) {
  const calls = completedCalls(trace);
  const routeProbes = packetlessRouteProbes(calls);
  return calls.filter((line, index) => {
    if (!/\b(?:connect|sendto|sendmsg|sendmmsg)\(/.test(line)) return false;
    if (routeProbes.has(index)) return false;
    // A host resolver reached through a Unix socket can send DNS outside the
    // test's network namespace. Check its named requests as well as IP sockets.
    if (line.includes("io.systemd.Resolve.ResolveHostname")) {
      const name = line.match(/\\?"name\\?"\s*:\s*\\?"([^"\\]+)\\?"/)?.[1];
      if (!name || !["localhost", "127.0.0.1", "::1"].includes(name)) return true;
    }
    // Skip quoted payloads and inspect each sockaddr separately: sendmmsg can
    // contain both local and external destinations in the same syscall.
    for (const [field] of line.matchAll(
      /"(?:\\.|[^"\\])*"|\{(?:sa_family|sin6_family)=AF_INET6?\b[^{}]*(?:\}|$)/g,
    )) {
      if (!field.startsWith("{")) continue;
      if (!/(?:inet_addr\("127\.0\.0\.1"\)|inet_pton\(AF_INET6, "::1",)/.test(field)) return true;
    }
    return false;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const trace = readFileSync(process.argv[2], "utf8");
  if (!trace.includes("connect("))
    throw new Error("No connection trace was captured; the smoke test is incomplete.");
  const failures = unexpectedConnections(trace);
  if (failures.length)
    throw new Error(
      `Unexpected network attempts by the packaged application:\n${failures.join("\n")}`,
    );
  console.log("No external requests or packet transmissions detected.");
}
