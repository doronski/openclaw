import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onAgentAuditEvent,
  onAgentEvent,
  resetAgentEventsForTest,
} from "../../../infra/agent-events.js";
import type { SpawnInput } from "../types.js";
import { createSystemdUserAdapter } from "./systemd-user.js";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  readFile: vi.fn(),
  createChildAdapter: vi.fn(),
  emitDiagnosticEvent: vi.fn(),
}));
vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));
vi.mock("node:fs/promises", () => ({ default: { readFile: mocks.readFile } }));
vi.mock("./child.js", () => ({ createChildAdapter: mocks.createChildAdapter }));
vi.mock("../../../infra/diagnostic-events.js", () => ({
  emitDiagnosticEvent: mocks.emitDiagnosticEvent,
}));

describe.skipIf(process.platform !== "linux")("systemd user command containment", () => {
  let finish: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void;
  let serviceResult: string;
  let populated: boolean;
  let sliceMemory: string;
  let controlAvailable: boolean;
  let stopSucceeds: boolean;
  let selfCgroup: string;
  let serviceObserved: boolean;
  let servicePid: string;
  let serviceCgroup: string | undefined;
  const killLauncher = vi.fn();
  const stdout = vi.fn();
  const stderr = vi.fn();
  const stdin = { write: vi.fn(), end: vi.fn() };
  const input = (): Extract<SpawnInput, { mode: "child" }> & { runId: string } => ({
    mode: "child",
    runId: "run-1",
    sessionId: "session-1",
    backendId: "exec-host",
    toolCallId: "tool-1",
    argv: ["/bin/sh", "-c", "printf '%s' '$TOKEN'"],
    cwd: "/workspace",
    env: { TOKEN: "private-value", PATH: "/usr/bin:/bin" },
    resourceLimits: { backend: "systemd-user", slice: "commands.slice" },
  });
  const argsCalls = () => mocks.execFile.mock.calls.map((call) => call[1] as string[]);

  beforeEach(() => {
    vi.clearAllMocks();
    serviceResult = "success";
    populated = false;
    sliceMemory = "4294967296";
    controlAvailable = true;
    stopSucceeds = true;
    selfCgroup = "/user.slice/app.slice/gateway.service";
    serviceObserved = true;
    servicePid = "1234";
    serviceCgroup = undefined;
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      finish = resolve;
    });
    mocks.createChildAdapter.mockResolvedValue({
      pid: 999,
      stdin,
      onStdout: stdout,
      onStderr: stderr,
      kill: killLauncher,
      dispose: vi.fn(),
      wait: () => exit,
    });
    mocks.execFile.mockImplementation((_file, args: string[], _options, callback) => {
      const verb = args[2];
      if (!controlAvailable || (verb === "stop" && !stopSucceeds)) {
        callback(new Error("private diagnostic must not escape"), "", "private-value");
      } else if (verb === "show-environment") {
        callback(null, "MANAGER_SECRET=private-manager-value\n", "");
      } else if (verb === "show") {
        if (args.at(-1) !== "commands.slice" && !serviceObserved) {
          callback(new Error("unit unavailable"), "LoadState=not-found\n", "");
          return;
        }
        callback(
          null,
          args.at(-1) === "commands.slice"
            ? "LoadState=loaded\nActiveState=active\nControlGroup=/user.slice/commands.slice\n"
            : `LoadState=loaded\nActiveState=${stopSucceeds ? "inactive" : "active"}\nControlGroup=${serviceCgroup ?? `/user.slice/commands.slice/${args.at(-1)}`}\nExecMainPID=${servicePid}\nMemoryPeak=4096\nResult=${serviceResult}\n`,
          "",
        );
      } else {
        callback(null, "", "");
      }
    });
    mocks.readFile.mockImplementation(async (file: string) => {
      if (file === "/proc/self/cgroup") {
        return `0::${selfCgroup}\n`;
      }
      if (file.endsWith("memory.max")) {
        return sliceMemory;
      }
      if (file.endsWith("pids.max")) {
        return "256";
      }
      if (file.endsWith("cgroup.events")) {
        return `populated ${populated ? 1 : 0}\nfrozen 0`;
      }
      throw new Error(`Unexpected read ${file}`);
    });
  });
  afterEach(() => {
    resetAgentEventsForTest();
    killLauncher.mockReset();
    vi.unstubAllGlobals();
  });

  it("publishes actual start and aborted-cleanup identity only to the private audit owner", async () => {
    const audit = vi.fn();
    const publicAgentEvents = vi.fn();
    onAgentAuditEvent(audit);
    onAgentEvent(publicAgentEvents);
    const adapter = await createSystemdUserAdapter(input());
    expect(audit.mock.calls[0][0].data).toMatchObject({
      phase: "started",
      childPid: undefined,
      cgroup: undefined,
      expectedCgroup: expect.stringMatching(/^\/user.slice\/commands.slice\/openclaw-exec-/),
    });
    const started = audit.mock.calls.at(-1)![0];
    expect(started).toMatchObject({
      runId: "run-1",
      sessionKey: "session-1",
      stream: "exec.process.containment",
      data: {
        phase: "started",
        toolCallId: "tool-1",
        childPid: 1234,
        unit: expect.stringMatching(/^openclaw-exec-.*\.service$/),
        cgroup: expect.stringMatching(/^\/user.slice\/commands.slice\/openclaw-exec-/),
      },
    });
    adapter.kill("SIGTERM");
    finish({ code: null, signal: "SIGTERM" });
    await adapter.wait();
    expect(audit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        runId: "run-1",
        data: expect.objectContaining({
          phase: "completed",
          unit: started.data.unit,
          cgroup: started.data.cgroup,
          childPid: 1234,
          cleanupVerified: true,
          endedAtMs: expect.any(Number),
        }),
      }),
    );
    expect(publicAgentEvents).not.toHaveBeenCalled();
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/private-value|printf|TOKEN/);
    adapter.dispose();
  });

  it("puts the exact command and cwd in a bounded service without environment values in argv", async () => {
    const adapter = await createSystemdUserAdapter(input());
    const invocation = mocks.createChildAdapter.mock.calls[0][0];
    expect(invocation.argv).toEqual(
      expect.arrayContaining([
        "--user",
        "--pipe",
        "--wait",
        "--service-type=exec",
        "--expand-environment=no",
        "--working-directory=/workspace",
        "--slice=commands.slice",
        "--property=MemoryHigh=1073741824",
        "--property=MemoryMax=2147483648",
        "--property=MemorySwapMax=0",
        "--property=TasksMax=128",
        "--property=RuntimeMaxSec=60s",
        "--property=TimeoutStopSec=5s",
        "--property=KillMode=control-group",
        "--property=SendSIGKILL=yes",
        "--setenv=TOKEN",
        "--property=UnsetEnvironment=MANAGER_SECRET",
      ]),
    );
    expect(invocation.argv.slice(-4)).toEqual(["--", ...input().argv]);
    expect(invocation.argv.join(" ")).not.toContain("private-value");
    expect(adapter.pid).toBeUndefined();
    expect(adapter.stdin).toBe(stdin);
    const listener = vi.fn();
    adapter.onStdout(listener);
    adapter.onStderr(listener);
    expect(stdout).toHaveBeenCalledWith(listener);
    expect(stderr).toHaveBeenCalledWith(listener);
    finish({ code: 0, signal: null });
    await expect(adapter.wait()).resolves.toMatchObject({ code: 0 });
    expect(argsCalls().some((args) => args[2] === "stop")).toBe(true);
    expect(mocks.emitDiagnosticEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "exec.process.containment",
        phase: "completed",
        runId: "run-1",
        sessionId: "session-1",
        toolCallId: "tool-1",
        childPid: 1234,
        memoryPeakBytes: 4096,
        unit: expect.stringMatching(/^openclaw-exec-.*\.service$/),
        cgroup: expect.stringMatching(/^\/user.slice\/commands.slice\/openclaw-exec-/),
        expectedCgroup: expect.stringMatching(/^\/user.slice\/commands.slice\/openclaw-exec-/),
      }),
    );
    expect(JSON.stringify(mocks.emitDiagnosticEvent.mock.calls)).not.toContain("private-value");
    expect(JSON.stringify(mocks.emitDiagnosticEvent.mock.calls)).not.toContain("printf");
    adapter.dispose();
  });

  it("keeps private observation disposed when a pending wait finishes later", async () => {
    const audit = vi.fn();
    onAgentAuditEvent(audit);
    const adapter = await createSystemdUserAdapter(input());
    const pending = adapter.wait();
    adapter.dispose();
    expect(audit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        runId: "run-1",
        data: expect.objectContaining({ phase: "disposed", childPid: 1234 }),
      }),
    );
    expect(audit.mock.calls.some(([event]) => event.data.phase === "completed")).toBe(false);
    expect(audit.mock.calls.at(-1)?.[0].data).not.toHaveProperty("cleanupVerified");
    expect(mocks.emitDiagnosticEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "started" }),
    );
    finish({ code: 0, signal: null });
    await expect(pending).resolves.toMatchObject({ code: 0 });
    expect(audit).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ phase: "disposed" }) }),
    );
    expect(audit.mock.calls.some(([event]) => event.data.phase === "completed")).toBe(false);
    expect(mocks.emitDiagnosticEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "completed", cleanupVerified: true }),
    );
  });

  it.each(["max", "", "0"])(
    "refuses an aggregate slice without a finite memory budget (%s)",
    async (memory) => {
      sliceMemory = memory;
      await expect(createSystemdUserAdapter(input())).rejects.toThrow("finite cgroup v2");
      expect(mocks.createChildAdapter).not.toHaveBeenCalled();
    },
  );

  it.each(["/user.slice/commands.slice", "/user.slice/commands.slice/gateway.service"])(
    "refuses a workload slice containing the gateway owner (%s)",
    async (owner) => {
      selfCgroup = owner;
      await expect(createSystemdUserAdapter(input())).rejects.toThrow(
        "must not contain the gateway",
      );
      expect(mocks.createChildAdapter).not.toHaveBeenCalled();
    },
  );

  it("omits PID zero rather than reporting it as an observed command", async () => {
    servicePid = "0";
    const adapter = await createSystemdUserAdapter(input());
    finish({ code: 0, signal: null });
    await adapter.wait();
    expect(mocks.emitDiagnosticEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ childPid: undefined, cleanupVerified: true }),
    );
    adapter.dispose();
  });

  it("retains a positive polled service PID when terminal properties reset it to zero", async () => {
    const audit = vi.fn();
    onAgentAuditEvent(audit);
    servicePid = "0";
    const adapter = await createSystemdUserAdapter(input());
    servicePid = "1234";
    await vi.waitFor(() => {
      const serviceReads = mocks.execFile.mock.calls.filter((call) => {
        const args = call[1] as string[];
        return args[2] === "show" && args.at(-1) !== "commands.slice";
      });
      expect(serviceReads.length).toBeGreaterThan(1);
    });
    expect(audit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ phase: "started", childPid: 1234 }),
      }),
    );
    servicePid = "0";
    finish({ code: 0, signal: null });
    await adapter.wait();
    expect(mocks.emitDiagnosticEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ childPid: 1234, toolCallId: "tool-1", cleanupVerified: true }),
    );
    adapter.dispose();
  });

  it("retains trusted --wait success when a short service unloads before observation", async () => {
    const audit = vi.fn();
    onAgentAuditEvent(audit);
    serviceObserved = false;
    stopSucceeds = false;
    finish({ code: 0, signal: null });
    const adapter = await createSystemdUserAdapter(input());
    await expect(adapter.wait()).resolves.toMatchObject({ code: 0 });
    expect(mocks.emitDiagnosticEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        cgroup: undefined,
        expectedCgroup: expect.stringMatching(/^\/user.slice\/commands.slice\/openclaw-exec-/),
      }),
    );
    expect(mocks.emitDiagnosticEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ childPid: undefined, cleanupVerified: true }),
    );
    expect(audit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          phase: "completed",
          childPid: undefined,
          cgroup: undefined,
          expectedCgroup: expect.stringMatching(/^\/user.slice\/commands.slice\/openclaw-exec-/),
        }),
      }),
    );
    adapter.dispose();
  });

  it("does not infer cleanup from an absent never-observed service after launcher failure", async () => {
    serviceObserved = false;
    stopSucceeds = false;
    finish({ code: 1, signal: null });
    const adapter = await createSystemdUserAdapter(input());
    await expect(adapter.wait()).rejects.toThrow("cannot verify cleanup of an unobserved service");
    expect(mocks.emitDiagnosticEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "completed", cleanupVerified: false }),
    );
    adapter.dispose();
  });

  it("fails closed when the user manager is unavailable", async () => {
    controlAvailable = false;
    await expect(createSystemdUserAdapter(input())).rejects.toThrow("backend unavailable");
    expect(mocks.createChildAdapter).not.toHaveBeenCalled();
  });

  it("rejects invalid limits and manager redirection before spawning", async () => {
    const invalid = input();
    invalid.resourceLimits = { backend: "systemd-user", slice: "../user.slice" };
    await expect(createSystemdUserAdapter(invalid)).rejects.toThrow("Invalid");
    const redirected = input();
    redirected.env = { DBUS_SESSION_BUS_ADDRESS: "unix:path=/untrusted" };
    await expect(createSystemdUserAdapter(redirected)).rejects.toThrow("manager transport");
    expect(mocks.createChildAdapter).not.toHaveBeenCalled();
  });

  it("caps explicit long timeouts and allows operator-configured larger envelopes", async () => {
    const larger = input();
    larger.timeoutMs = 900_000;
    larger.resourceLimits = {
      ...larger.resourceLimits!,
      memoryMaxBytes: 8_589_934_592,
      timeoutSec: 300,
    };
    const adapter = await createSystemdUserAdapter(larger);
    expect(mocks.createChildAdapter.mock.calls[0][0].argv).toEqual(
      expect.arrayContaining(["--property=MemoryMax=8589934592", "--property=RuntimeMaxSec=300s"]),
    );
    serviceResult = "timeout";
    finish({ code: 143, signal: null });
    await expect(adapter.wait()).resolves.toEqual({ code: 143, signal: null });
    adapter.dispose();
  });

  it("retains a stop timeout in diagnostics without inferring an elapsed command budget", async () => {
    const adapter = await createSystemdUserAdapter(input());
    serviceResult = "timeout";
    finish({ code: 1, signal: null });
    await expect(adapter.wait()).resolves.toEqual({ code: 1, signal: null });
    expect(mocks.emitDiagnosticEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ result: "timeout", exitCode: 1, cleanupVerified: true }),
    );
    adapter.dispose();
  });

  it("cancels the service cgroup and waits for stop verification instead of killing its launcher", async () => {
    const adapter = await createSystemdUserAdapter(input());
    adapter.kill("SIGTERM");
    adapter.kill("SIGKILL");
    finish({ code: 143, signal: null });
    await adapter.wait();
    expect(argsCalls().filter((args) => args[2] === "stop")).toHaveLength(1);
    expect(argsCalls()).toContainEqual(
      expect.arrayContaining(["kill", "--kill-whom=all", "--signal=SIGKILL"]),
    );
    expect(killLauncher).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it("refuses to report completion while any descendant cgroup is populated", async () => {
    const adapter = await createSystemdUserAdapter(input());
    populated = true;
    finish({ code: 0, signal: null });
    await expect(adapter.wait()).rejects.toThrow("still populated");
    adapter.dispose();
  });

  it("rejects a service observed outside its expected cgroup even when the expected path is absent", async () => {
    const adapter = await createSystemdUserAdapter(input());
    serviceCgroup = "/user.slice/other.slice/unexpected.service";
    mocks.readFile.mockRejectedValue(Object.assign(new Error("absent"), { code: "ENOENT" }));
    finish({ code: 0, signal: null });
    await expect(adapter.wait()).rejects.toThrow("cgroup does not match");
    expect(mocks.emitDiagnosticEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ cgroup: serviceCgroup, cleanupVerified: false }),
    );
    adapter.dispose();
  });

  it.each(["stop", "manager"])(
    "hard-kills a stuck launcher after %s failure without verifying service cleanup",
    async (failure) => {
      const adapter = await createSystemdUserAdapter(input());
      stopSucceeds = false;
      controlAvailable = failure !== "manager";
      killLauncher.mockImplementation(() => finish({ code: null, signal: "SIGKILL" }));
      adapter.kill("SIGTERM");
      await expect(adapter.wait()).rejects.toThrow();
      expect(killLauncher).toHaveBeenCalledWith("SIGKILL");
      expect(mocks.emitDiagnosticEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({ phase: "completed", cleanupVerified: false }),
      );
      expect(mocks.execFile.mock.calls.every((call) => call[2].killSignal === "SIGKILL")).toBe(
        true,
      );
      adapter.dispose();
    },
  );

  it("settles a stuck launcher after verified service stop", async () => {
    const adapter = await createSystemdUserAdapter(input());
    killLauncher.mockImplementation(() => finish({ code: null, signal: "SIGKILL" }));
    adapter.kill("SIGTERM");
    await expect(adapter.wait()).resolves.toMatchObject({ signal: "SIGKILL" });
    expect(killLauncher).toHaveBeenCalledWith("SIGKILL");
    expect(mocks.emitDiagnosticEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ cleanupVerified: true }),
    );
    adapter.dispose();
  });

  it("does not silently accept a failed stop of an active service", async () => {
    const adapter = await createSystemdUserAdapter(input());
    stopSucceeds = false;
    finish({ code: 0, signal: null });
    await expect(adapter.wait()).rejects.toThrow("could not be stopped");
    adapter.dispose();
  });
});
