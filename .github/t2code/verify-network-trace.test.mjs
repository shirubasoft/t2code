import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { unexpectedConnections } from "./verify-network-trace.mjs";

const local = '{sa_family=AF_INET, sin_port=htons(3773), sin_addr=inet_addr("127.0.0.1")}';
const external = '{sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("142.251.128.238")}';

NodeTest.test("every destination in a sendmmsg batch must be loopback", () => {
  const message = (address) =>
    `{msg_hdr={msg_name=${address}, msg_namelen=16, msg_iov=[{iov_base="x", iov_len=1}], msg_iovlen=1}, msg_len=1}`;
  const mixed = `42 sendmmsg(7, [${message(local)}, ${message(external)}], 2, 0) = -1 ENETUNREACH`;
  const reverse = `42 sendmmsg(7, [${message(external)}, ${message(local)}], 2, 0) = -1 ENETUNREACH`;
  const permitted = `42 sendmmsg(7, [${message(local)}, ${message(local)}], 2, 0) = 2`;
  NodeAssert.deepEqual(unexpectedConnections([mixed, reverse, permitted].join("\n")), [
    mixed,
    reverse,
  ]);
});

NodeTest.test("IPv6 loopback passes but failed and unfinished external attempts fail", () => {
  const loopback =
    '42 connect(7, {sa_family=AF_INET6, sin6_port=htons(3773), inet_pton(AF_INET6, "::1", &sin6_addr), sin6_scope_id=0}, 28) = 0';
  const denied =
    '43 connect(22, {sa_family=AF_INET6, sin6_port=htons(443), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, "2001:4860:4860::8888", &sin6_addr), sin6_scope_id=0}, 28 <unfinished ...>';
  NodeAssert.deepEqual(unexpectedConnections([loopback, denied].join("\n")), [denied]);
});

NodeTest.test("quoted data cannot hide or fabricate a socket destination", () => {
  const localPayload = JSON.stringify(local);
  const externalPayload = JSON.stringify(external);
  const denied = `42 sendto(7, ${localPayload}, 100, 0, ${external}, 16) = -1 ENETUNREACH`;
  const allowed = `42 sendto(7, ${externalPayload}, 100, 0, ${local}, 16) = 100`;
  NodeAssert.deepEqual(unexpectedConnections([denied, allowed].join("\n")), [denied]);
});

NodeTest.test("systemd resolver requests cannot escape the network namespace unnoticed", () => {
  const query = (name) =>
    `42 sendto(82, ${JSON.stringify(JSON.stringify({ method: "io.systemd.Resolve.ResolveHostname", parameters: { name, flags: 0, ifindex: 0 } }) + "\0")}, 114, MSG_DONTWAIT|MSG_NOSIGNAL, NULL, 0 <unfinished ...>`;
  const externalQuery = query("redirector.gvt1.com");
  NodeAssert.deepEqual(
    unexpectedConnections(
      [externalQuery, query("localhost"), query("127.0.0.1"), query("::1")].join("\n"),
    ),
    [externalQuery],
  );
});

const probeSocket = "25<UDPv6:[901]>";
const probeCreate = `89 socket(AF_INET6, SOCK_DGRAM, IPPROTO_IP) = ${probeSocket}`;
const probeConnect = `89 connect(${probeSocket}, {sa_family=AF_INET6, sin6_port=htons(443), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, "2001:4860:4860::8888", &sin6_addr), sin6_scope_id=0}, 28) = -1 ENETUNREACH (Network is unreachable)`;
const probeClose = `90 close(${probeSocket}) = 0`;

NodeTest.test("a closed unreachable UDP route probe carries no external request or packet", () => {
  const trace = [
    probeCreate,
    `89 fcntl(${probeSocket}, F_SETFL, O_RDONLY|O_NONBLOCK) = 0`,
    probeConnect,
    probeClose,
  ].join("\n");
  NodeAssert.deepEqual(unexpectedConnections(trace), []);
  // File descriptor reuse belongs to the new socket, not the probe's inode.
  const reused =
    trace +
    `\n89 socket(AF_INET, SOCK_STREAM, IPPROTO_TCP) = 25<TCP:[902]>\n89 connect(25<TCP:[902]>, ${local}, 16) = 0`;
  NodeAssert.deepEqual(unexpectedConnections(reused), []);
});

NodeTest.test(
  "route probes require creation, close, datagram type, exact destination, and failure receipts",
  () => {
    const invalidTraces = [
      [probeConnect, probeClose],
      [probeCreate, probeConnect],
      [probeCreate.replace("SOCK_DGRAM", "SOCK_STREAM"), probeConnect, probeClose],
      [
        probeCreate,
        probeConnect.replace("2001:4860:4860::8888", "2001:4860:4860::8844"),
        probeClose,
      ],
      [probeCreate, probeConnect.replace("htons(443)", "htons(53)"), probeClose],
      [
        probeCreate,
        probeConnect.replace("-1 ENETUNREACH (Network is unreachable)", "0"),
        probeClose,
      ],
    ];
    for (const lines of invalidTraces)
      NodeAssert.equal(unexpectedConnections(lines.join("\n")).length, 1);
  },
);

NodeTest.test(
  "writes, sends and duplicates on a probe socket invalidate the exception across threads and descriptor aliases",
  () => {
    for (const operation of [
      `90 write(41<UDPv6:[901]>, "payload", 7) = 7`,
      `90 writev(${probeSocket}, [{iov_base="payload", iov_len=7}], 1) = 7`,
      `90 sendto(${probeSocket}, "payload", 7, 0, NULL, 0) = 7`,
      `90 sendmsg(${probeSocket}, {msg_name=NULL, msg_iov=[{iov_base="payload", iov_len=7}]}, 0) = 7`,
      `90 dup(${probeSocket}) = 41<UDPv6:[901]>`,
      `90 fcntl(${probeSocket}, F_DUPFD, 0) = 41<UDPv6:[901]>`,
    ]) {
      NodeAssert.deepEqual(
        unexpectedConnections([probeCreate, probeConnect, operation, probeClose].join("\n")),
        [probeConnect],
      );
    }
  },
);

NodeTest.test("interleaved unfinished route probe syscalls are matched by thread", () => {
  const trace = [
    "89 socket(AF_INET6, SOCK_DGRAM, IPPROTO_IP <unfinished ...>",
    `90 connect(7<TCP:[902]>, ${local}, 16) = 0`,
    `89 <... socket resumed>) = ${probeSocket}`,
    probeConnect.replace(") = -1 ENETUNREACH (Network is unreachable)", " <unfinished ...>"),
    "89 <... connect resumed>) = -1 ENETUNREACH (Network is unreachable)",
    probeClose,
  ];
  NodeAssert.deepEqual(unexpectedConnections(trace.join("\n")), []);
});

NodeTest.test(
  "the packaged Linux probe keeps its identity when the kernel autobinds before failing",
  () => {
    const trace = [
      "76 socket(AF_INET6, SOCK_DGRAM, IPPROTO_IP <unfinished ...>",
      "76 <... socket resumed>) = 24<UDPv6:[69937407]>",
      "76 fcntl(24<UDPv6:[69937407]>, F_GETFL <unfinished ...>",
      "76 <... fcntl resumed>) = 0x2 (flags O_RDWR)",
      "76 fcntl(24<UDPv6:[69937407]>, F_SETFL, O_RDWR|O_NONBLOCK <unfinished ...>",
      "76 <... fcntl resumed>) = 0",
      '76 connect(24<UDPv6:[69937407]>, {sa_family=AF_INET6, sin6_port=htons(443), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, "2001:4860:4860::8888", &sin6_addr), sin6_scope_id=0}, 28 <unfinished ...>',
      "76 <... connect resumed>) = -1 ENETUNREACH (Network is unreachable)",
      "76 close(24<UDPv6:[[::]:50669]> <unfinished ...>",
      "76 <... close resumed>) = 0",
    ];
    NodeAssert.deepEqual(unexpectedConnections(trace.join("\n")), []);
  },
);

NodeTest.test("a bound endpoint can only close the original thread's descriptor", () => {
  const boundClose = "89 close(25<UDPv6:[[::]:50669]>) = 0";
  const invalidTraces = [
    [probeCreate, probeConnect, boundClose.replace("89 close", "90 close")],
    [probeCreate, probeConnect, boundClose.replace("close(25", "close(26")],
    [
      probeCreate,
      probeConnect,
      "89 socket(AF_INET6, SOCK_DGRAM, IPPROTO_IP) = 25<UDPv6:[902]>",
      boundClose,
    ],
  ];
  for (const lines of invalidTraces)
    NodeAssert.deepEqual(unexpectedConnections(lines.join("\n")), [probeConnect]);
});

NodeTest.test(
  "a bound probe endpoint rejects transmissions from any thread or descriptor before and after close",
  () => {
    const boundClose = "89 close(25<UDPv6:[[::]:50669]>) = 0";
    for (const operation of [
      '90 write(45<UDPv6:[[::]:50669]>, "payload", 7) = 7',
      '90 sendto(45<UDPv6:[[::]:50669]>, "payload", 7, 0, NULL, 0) = 7',
      '89 sendmsg(25<UDPv6:[[::]:50669]>, {msg_name=NULL, msg_iov=[{iov_base="payload", iov_len=7}]}, 0) = 7',
    ]) {
      for (const tail of [
        [operation, boundClose],
        [boundClose, operation],
      ]) {
        NodeAssert.deepEqual(
          unexpectedConnections([probeCreate, probeConnect, ...tail].join("\n")),
          [probeConnect],
        );
      }
    }
  },
);
