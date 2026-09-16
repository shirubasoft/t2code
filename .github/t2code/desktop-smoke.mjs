import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export function waitForDevtools(child, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const finish = (error, endpoint) => {
      clearTimeout(timer);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolve(endpoint);
    };
    const onData = (chunk) => {
      output = (output + chunk.toString()).slice(-16_384);
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)\s/);
      if (!match) return;
      let endpoint;
      try {
        endpoint = new URL(match[1]);
      } catch {
        finish(new Error("Desktop announced an invalid DevTools endpoint."));
        return;
      }
      if (endpoint.hostname !== "127.0.0.1" || !endpoint.port) {
        finish(new Error(`Unexpected desktop debugging address: ${endpoint.host}`));
      } else {
        finish(null, endpoint.href);
      }
    };
    const onExit = (code, signal) =>
      finish(new Error(`Desktop exited before DevTools was ready: ${code ?? signal}`));
    const onError = (error) => finish(error);
    const timer = setTimeout(
      () => finish(new Error("Desktop never announced its DevTools endpoint.")),
      timeoutMs,
    );
    child.stderr.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

export function fatalDesktopOutput(output) {
  return /Cannot find module|MODULE_NOT_FOUND|Uncaught (?:Exception|Error|TypeError|ReferenceError)|\bFATAL[: ]|Error launching app/i.test(
    output,
  );
}

export async function captureRendererDiagnostics(browser, evidence) {
  if (!browser) return;
  const pages = browser.contexts().flatMap((context) => context.pages());
  await Promise.allSettled(
    pages.map(async (page, index) => {
      const prefix = NodePath.join(evidence, `renderer-${index}`);
      NodeFS.writeFileSync(`${prefix}.url.txt`, page.url() + "\n");
      await Promise.allSettled([
        page.screenshot({ path: `${prefix}.png`, timeout: 5_000 }),
        page
          .locator("body")
          .innerText({ timeout: 5_000 })
          .then((body) => NodeFS.writeFileSync(`${prefix}.body.txt`, body)),
      ]);
    }),
  );
}

export async function closeBrowserWithin(browser, timeoutMs = 3_000) {
  if (!browser) return;
  let deadline;
  try {
    await Promise.race([
      browser.close().catch(() => {}),
      new Promise((resolve) => {
        deadline = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

async function smoke(executable, evidence) {
  const requireDesktop = NodeModule.createRequire(
    new URL("../../apps/desktop/package.json", import.meta.url),
  );
  const { chromium } = requireDesktop("playwright-core");
  NodeFS.mkdirSync(evidence, { recursive: true });
  // strace and hosted Linux cannot use Chromium's setuid sandbox. This switch
  // does not suppress background services; their network attempts remain visible.
  const child = NodeChildProcess.spawn(
    executable,
    [
      "--no-sandbox",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--log-net-log=${NodePath.join(evidence, "chromium-netlog.json")}`,
    ],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const record = (chunk) => {
    output = (output + chunk.toString()).slice(-1_048_576);
  };
  child.stdout.on("data", record);
  child.stderr.on("data", record);
  let stopping = false;
  let browser;
  let deadline;
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
  const failed = new Promise((_, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (!stopping) reject(new Error(`Desktop exited during verification: ${code ?? signal}`));
    });
    deadline = setTimeout(() => reject(new Error("Packaged desktop readiness timed out.")), 90_000);
  });
  const terminate = (signal) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  try {
    await Promise.race([
      failed,
      (async () => {
        const endpoint = await waitForDevtools(child);
        browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
        const context = browser.contexts()[0];
        if (!context) throw new Error("Desktop has no renderer context.");
        const pageErrors = [];
        const observe = (page) => {
          page.on("pageerror", (error) => pageErrors.push(error.message));
          page.on("crash", () => pageErrors.push("Desktop renderer crashed."));
        };
        context.on("page", observe);
        for (const page of context.pages()) observe(page);
        const page =
          context.pages()[0] ?? (await context.waitForEvent("page", { timeout: 30_000 }));
        page.setDefaultTimeout(30_000);
        await page.waitForURL((url) => url.protocol === "t2code:" && url.host === "app", {
          waitUntil: "domcontentloaded",
        });
        NodeFS.writeFileSync(
          NodePath.join(evidence, "network-state.json"),
          JSON.stringify({ online: await page.evaluate(() => navigator.onLine) }) + "\n",
        );
        const setup = page.getByRole("heading", { name: "Set up this computer", exact: true });
        const addProject = page.getByRole("button", { name: "Add project", exact: true }).first();
        await setup.or(addProject).first().waitFor({ state: "visible" });
        if (await setup.isVisible()) {
          await page.getByRole("button", { name: "Continue", exact: true }).click();
          await page.getByRole("heading", { name: "Your agents", exact: true }).waitFor();
          await page.getByRole("button", { name: "Continue", exact: true }).click();
          await page.getByRole("button", { name: "Do not import projects", exact: true }).click();
        }
        await addProject.waitFor({ state: "visible" });
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        const search = page.getByRole("combobox", { name: "Search settings", exact: true });
        await search.fill("spellchecker regression probe");
        await page.getByRole("status").filter({ hasText: "No settings found" }).waitFor();
        await page.screenshot({ path: NodePath.join(evidence, "settings.png") });
        pageErrors.push(...(await page.pageErrors()).map((error) => error.message));
        if (pageErrors.length) throw new Error(`Desktop renderer errors: ${pageErrors.join("; ")}`);
        if (fatalDesktopOutput(output)) throw new Error("Fatal packaged desktop startup error.");
        console.log("Fresh packaged desktop completed local onboarding and opened Settings.");
      })(),
    ]);
    stopping = true;
    clearTimeout(deadline);
    // Only the process group captured at spawn is signalled. Closing a window
    // can leave Electron's tray and backend running, so terminate the whole run.
    terminate("SIGTERM");
    let shutdownDeadline;
    try {
      await Promise.race([
        exited,
        new Promise((_, reject) => {
          shutdownDeadline = setTimeout(
            () => reject(new Error("Desktop did not shut down.")),
            10_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(shutdownDeadline);
    }
  } catch (error) {
    await captureRendererDiagnostics(browser, evidence);
    throw error;
  } finally {
    stopping = true;
    clearTimeout(deadline);
    NodeFS.writeFileSync(NodePath.join(evidence, "desktop.log"), output);
    terminate("SIGKILL");
    child.stdout.destroy();
    child.stderr.destroy();
    await closeBrowserWithin(browser);
  }
}

if (
  process.argv[1] &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
) {
  if (process.argv.length !== 4)
    throw new Error("Usage: desktop-smoke.mjs <executable> <evidence-directory>");
  try {
    await smoke(NodePath.resolve(process.argv[2]), NodePath.resolve(process.argv[3]));
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
  // A dead CDP transport may keep sockets referenced after bounded cleanup.
  // Exiting delivers the wrapper's receipt; its private PID namespace then
  // removes all remaining descendants, including detached backend processes.
  process.exit(0);
}
