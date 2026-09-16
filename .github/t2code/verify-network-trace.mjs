import * as NodeFS from "node:fs";
const { readFileSync } = NodeFS;
import * as NodePath from "node:path";
const { resolve } = NodePath;
import * as NodeURL from "node:url";
const { pathToFileURL } = NodeURL;

export function unexpectedConnections(trace) {
  return trace
    .split("\n")
    .filter(
      (line) =>
        /\b(?:connect|sendto|sendmsg|sendmmsg)\(/.test(line) &&
        /(?:sa_family|sin6_family)=AF_INET6?\b/.test(line) &&
        !/(?:inet_addr\("127\.0\.0\.1"\)|inet_pton\(AF_INET6, "::1",)/.test(line),
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const trace = readFileSync(process.argv[2], "utf8");
  if (!trace.includes("connect("))
    throw new Error("No connection trace was captured; the smoke test is incomplete.");
  const failures = unexpectedConnections(trace);
  if (failures.length)
    throw new Error(`Unexpected network attempts by the shipped CLI:\n${failures.join("\n")}`);
  console.log("Packaged CLI served the local client with zero external network attempts.");
}
