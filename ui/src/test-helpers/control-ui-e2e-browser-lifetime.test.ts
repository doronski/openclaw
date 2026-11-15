// @vitest-environment node
// Prove shared browser ownership through real Playwright connections and Vitest projects.
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { runVitestShutdownCommand } from "../../../test/helpers/vitest-shutdown-command.ts";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "./playwright-chromium.ts";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const helperPath = path.join(repoRoot, "ui/src/e2e/control-ui-e2e-suite.test-support.ts");

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
it.skipIf(!canRunPlaywrightChromium(chromiumExecutablePath))(
  "shares Chromium across native projects while isolating clients and custom launches",
  (context) => {
    const run = (async () => {
      // openclaw-temp-dir: allow retain native-fork state if process-tree shutdown fails.
      const root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "ui-browser-lifetime-")),
      );
      await fs.symlink(
        path.join(repoRoot, "node_modules"),
        path.join(root, "node_modules"),
        "junction",
      );
      const endpointFile = path.join(root, "endpoint.txt");
      const diagnosticDir = path.join(root, "diagnostics");
      const imports = `
import fs from "node:fs";
import { chromium } from "playwright";
import { expect, inject, it } from "vitest";
import { createControlUiE2eSuite } from ${JSON.stringify(helperPath)};
const startServer = async () => ({ baseUrl: "http://fixture.invalid/", close: async () => {} });
const suite = createControlUiE2eSuite({ name: "shared browser", startServer });
const endpoint = inject("controlUiE2eChromium").wsEndpoint;
`;
      await fs.writeFile(
        path.join(root, "first.test.ts"),
        `${imports}
suite.define(() => {
  it("disconnects only its own contexts", async (context) => {
    fs.writeFileSync(${JSON.stringify(endpointFile)}, endpoint);
    const sibling = await chromium.connect(endpoint);
    try {
      const ownContext = await suite.browser.newContext();
      const siblingContext = await sibling.newContext();
      const ownPage = await ownContext.newPage();
      await ownContext.addCookies([{ name: "own", value: "one", url: "http://fixture.invalid/" }]);
      expect(await siblingContext.cookies()).toEqual([]);
      await siblingContext.addCookies([{ name: "sibling", value: "two", url: "http://fixture.invalid/" }]);
      const crashed = await ownContext.newPage();
      await crashed.goto("data:text/html,<title>synthetic-private-page</title>");
      const cdp = await ownContext.newCDPSession(crashed);
      const { targetInfo } = await cdp.send("Target.getTargetInfo");
      const diagnosticCode = (error: unknown) => {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (typeof code === "number" && Number.isSafeInteger(code)) return code;
        return typeof code === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(code) ? code : "UNAVAILABLE";
      };
      const readProc = (file: string, maxBytes = 4096) => {
        let descriptor: number | undefined;
        try {
          descriptor = fs.openSync(file, "r");
          const bytes = Buffer.alloc(maxBytes);
          const length = fs.readSync(descriptor, bytes, 0, maxBytes, null);
          return { value: bytes.subarray(0, length).toString("utf8").trim(), truncated: length === maxBytes };
        } catch (error) {
          return { error: diagnosticCode(error) };
        } finally {
          if (descriptor !== undefined) fs.closeSync(descriptor);
        }
      };
      let rendererPids: number[] = [];
      if (process.platform === "linux") {
        const limits = readProc("/proc/self/limits");
        console.error("[ui-browser-lifetime] core policy", JSON.stringify({
          corePattern: readProc("/proc/sys/kernel/core_pattern", 256),
          corePipeLimit: readProc("/proc/sys/kernel/core_pipe_limit", 256),
          coredumpFilter: readProc("/proc/self/coredump_filter", 256),
          maxCoreFileSize: limits.error !== undefined ? { error: limits.error } : { value: limits.value?.split("\\n").find(line => line.startsWith("Max core file size"))?.slice(0, 256), truncated: limits.truncated },
        }));
        let browserCdp;
        try {
          browserCdp = await suite.browser.newBrowserCDPSession();
          const { processInfo } = await browserCdp.send("SystemInfo.getProcessInfo");
          const renderers = processInfo.filter(({ type, id }) => type === "renderer" && Number.isSafeInteger(id) && id > 0);
          rendererPids = renderers.slice(0, 32).map(({ id }) => id);
          // Correlate these OS PIDs with Chromium's FATAL line; do not infer page ownership.
          console.error("[ui-browser-lifetime] renderer PIDs", JSON.stringify({ pids: rendererPids, omitted: renderers.length - rendererPids.length }));
        } catch (error) {
          console.error("[ui-browser-lifetime] renderer PIDs", JSON.stringify({ error: diagnosticCode(error) }));
        } finally {
          await browserCdp?.detach().catch(error => {
            console.error("[ui-browser-lifetime] process observer detach", JSON.stringify({ error: diagnosticCode(error) }));
          });
        }
      }
      const crashEvent = crashed.waitForEvent("crash");
      let samples = 0;
      const processTimer = process.platform === "linux" ? setInterval(() => {
        const processes = rendererPids.map(pid => {
          const status = readProc("/proc/" + pid + "/status");
          if (status.error !== undefined) return { pid, error: status.error };
          const fields = Object.fromEntries((status.value ?? "").split("\\n").map(line => {
            const colon = line.indexOf(":");
            return [line.slice(0, colon), line.slice(colon + 1).trim()];
          }));
          const state = fields.State?.charAt(0);
          return fields.CoreDumping === "1" || ["Z", "T", "t"].includes(state)
            ? { pid, Name: fields.Name?.slice(0, 64), State: state, CoreDumping: fields.CoreDumping?.slice(0, 1), truncated: status.truncated }
            : undefined;
        }).filter(row => row !== undefined);
        console.error("[ui-browser-lifetime] renderer process sample", JSON.stringify({ sample: ++samples, at: new Date().toISOString(), inspected: rendererPids.length, processes }));
        if (samples === 14) clearInterval(processTimer);
      }, 1000) : undefined;
      processTimer?.unref();
      const stopProcessSamples = () => clearInterval(processTimer);
      context.signal.addEventListener("abort", stopProcessSamples, { once: true });
      console.error("[ui-browser-lifetime] dispatching Page.crash");
      const crashCommand = cdp.send("Page.crash").catch(() => {});
      console.error("[ui-browser-lifetime] waiting for page crash event");
      try {
        await crashEvent;
      } finally {
        stopProcessSamples();
        context.signal.removeEventListener("abort", stopProcessSamples);
      }
      // The raw CDP command can stay pending until its crashed target closes.
      console.error("[ui-browser-lifetime] closing crashed page");
      await crashed.close();
      console.error("[ui-browser-lifetime] joining Page.crash command");
      await crashCommand;
      const readCrash = () => {
        const directory = process.env.OPENCLAW_UI_E2E_DIAGNOSTIC_DIR;
        const entry = fs.existsSync(directory) && fs.readdirSync(directory).find(name => name.startsWith("failure-chromium-"));
        return entry ? fs.readFileSync(directory + "/" + entry + "/failure.public.json", "utf8") : "";
      };
      console.error("[ui-browser-lifetime] waiting for native crash diagnostic");
      await expect.poll(readCrash).not.toBe("");
      console.error("[ui-browser-lifetime] native crash diagnostic observed");
      const publicCrash = readCrash();
      expect(JSON.parse(publicCrash)).toMatchObject({
        kind: "chromium-target-crashes", dropped: 0,
        crashes: [{ targetId: targetInfo.targetId, status: "crashed", errorCode: expect.any(Number), at: expect.any(String) }],
      });
      expect(publicCrash).not.toContain("synthetic-private-page");
      expect(publicCrash).not.toContain("data:text/html");
      expect(publicCrash).not.toContain(endpoint);
      expect(await (await siblingContext.newPage()).evaluate(() => 2 + 2)).toBe(4);
      await suite.browser.close();
      expect(ownPage.isClosed()).toBe(true);
      expect(sibling.isConnected()).toBe(true);
      expect((await siblingContext.cookies()).map(cookie => cookie.name)).toEqual(["sibling"]);
    } finally {
      await sibling.close();
    }
  });
});
const privateSuite = createControlUiE2eSuite({
  name: "custom launch", startServer,
  browserLaunchOptions: { args: ["--user-agent=private-suite-browser"] },
});
privateSuite.define(() => {
  it("retains launch options instead of borrowing the shared process", async () => {
    const page = await privateSuite.browser.newPage();
    expect(await page.evaluate(() => navigator.userAgent)).toBe("private-suite-browser");
  });
});
`,
      );
      await fs.writeFile(
        path.join(root, "second.test.ts"),
        `${imports}
suite.define(() => {
  it("keeps the invocation browser alive after the earlier project finishes", async () => {
    expect(endpoint).toBe(fs.readFileSync(${JSON.stringify(endpointFile)}, "utf8"));
    expect(suite.browser.isConnected()).toBe(true);
    const browserContext = await suite.browser.newContext();
    expect(await browserContext.cookies()).toEqual([]);
  });
});
`,
      );
      const config = path.join(root, "vitest.config.ts");
      await fs.writeFile(
        config,
        `
import { defineConfig } from "vitest/config";
import { createVitestResolveConfig } from ${JSON.stringify(path.join(repoRoot, "test/vitest/vitest.resolve.ts"))};
if (process.versions.bun) {
  await import(${JSON.stringify(path.join(repoRoot, "test/vitest/vitest.sqlite-preload.mts"))});
}
export default defineConfig({
  test: { maxWorkers: 1, fileParallelism: false, projects: ["first", "second"].map((name, index) => ({
    extends: false,
    resolve: createVitestResolveConfig(${JSON.stringify(repoRoot)}),
    test: {
      name, include: [${JSON.stringify(root)} + "/" + name + ".test.ts"],
      globalSetup: [${JSON.stringify(path.join(repoRoot, "test/vitest/vitest.ui-e2e.global-setup.ts"))}],
      pool: "forks", isolate: true, maxWorkers: 1, hookTimeout: 15000, testTimeout: 15000,
      sequence: { groupOrder: index + 1 },
    },
  })) },
});
`,
      );
      let joined = false;
      try {
        const result = await runVitestShutdownCommand({
          args: [
            path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs"),
            "run",
            "--root",
            root,
            "--config",
            config,
            "--configLoader",
            "runner",
            "--fsModuleCache",
          ],
          cwd: repoRoot,
          signal: context.signal,
          timeoutMs: 90_000,
          env: {
            PATH: process.env.PATH,
            PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: chromiumExecutablePath,
            OPENCLAW_UI_E2E_DIAGNOSTIC_DIR: diagnosticDir,
            NODE_DISABLE_COMPILE_CACHE: "1",
            CI: "1",
            NO_COLOR: "1",
          },
        });
        joined = true;
        expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
        const output = result.stdout + result.stderr;
        for (const marker of [
          "dispatching Page.crash",
          "waiting for page crash event",
          "closing crashed page",
          "joining Page.crash command",
          "waiting for native crash diagnostic",
          "native crash diagnostic observed",
        ]) {
          expect(output).toContain(`[ui-browser-lifetime] ${marker}`);
        }
        expect(output).toContain("[ui-e2e] Chromium target crashed");
        const endpoint = await fs.readFile(endpointFile, "utf8");
        await expect(chromium.connect(endpoint, { timeout: 1_000 })).rejects.toThrow();
      } finally {
        if (joined) {
          await fs.rm(root, { recursive: true, force: true });
        } else {
          console.warn(`Retained unjoined native UI fixture: ${root}`);
        }
      }
    })();
    context.onTestFinished(() => run);
    return run;
  },
);
