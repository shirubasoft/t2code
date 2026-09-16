import * as NodeAssert from "node:assert/strict";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeTest from "node:test";
import {
  captureRendererDiagnostics,
  closeBrowserWithin,
  fatalDesktopOutput,
  waitForDevtools,
} from "./desktop-smoke.mjs";

function child() {
  const process = new NodeEvents.EventEmitter();
  process.stderr = new NodeStream.PassThrough();
  return process;
}

NodeTest.test("desktop readiness requires a complete loopback DevTools receipt", async () => {
  const process = child();
  const ready = waitForDevtools(process);
  process.stderr.write("Startup\nDevTools listening on ws://127.");
  process.stderr.write("0.0.1:43121/devtools/browser/test\n");
  NodeAssert.equal(await ready, "ws://127.0.0.1:43121/devtools/browser/test");
  NodeAssert.equal(process.listenerCount("exit"), 0);
  NodeAssert.equal(process.stderr.listenerCount("data"), 0);
});

NodeTest.test("desktop early exit, missing readiness and external CDP addresses fail", async () => {
  const exited = child();
  const exitResult = waitForDevtools(exited);
  exited.emit("exit", 0, null);
  await NodeAssert.rejects(exitResult, /exited before DevTools/);
  await NodeAssert.rejects(waitForDevtools(child(), 1), /never announced/);
  const external = child();
  const externalResult = waitForDevtools(external);
  external.stderr.write("DevTools listening on ws://example.invalid:42/devtools/browser/test\n");
  await NodeAssert.rejects(externalResult, /Unexpected desktop debugging address/);
});

NodeTest.test("fatal desktop output cannot pass as an offline startup", () => {
  NodeAssert.equal(fatalDesktopOutput("Error: Cannot find module '@napi-rs/keyring'"), true);
  NodeAssert.equal(fatalDesktopOutput("[123:FATAL:zygote_host_impl_linux.cc] failed"), true);
  NodeAssert.equal(fatalDesktopOutput("Uncaught TypeError: bridge is undefined"), true);
  NodeAssert.equal(fatalDesktopOutput("[ERROR:dbus] Failed to connect to the bus"), false);
});

NodeTest.test("teardown completes when CDP close never responds or rejects", async () => {
  await closeBrowserWithin({ close: () => new Promise(() => {}) }, 1);
  await closeBrowserWithin({
    close: async () => {
      throw new Error("CDP disconnected");
    },
  });
});

NodeTest.test(
  "failure diagnostics retain each page even if a renderer cannot take a screenshot",
  async () => {
    const directory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t2-renderer-diagnostics-"),
    );
    const page = (body) => ({
      url: () => `t2code://app/${body}`,
      screenshot: async () => {
        throw new Error("renderer stopped");
      },
      locator: () => ({ innerText: async () => body }),
    });
    try {
      await captureRendererDiagnostics(
        { contexts: () => [{ pages: () => [page("splash"), page("welcome")] }] },
        directory,
      );
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(directory, "renderer-0.body.txt"), "utf8"),
        "splash",
      );
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(directory, "renderer-1.body.txt"), "utf8"),
        "welcome",
      );
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(directory, "renderer-1.url.txt"), "utf8"),
        "t2code://app/welcome\n",
      );
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  },
);
