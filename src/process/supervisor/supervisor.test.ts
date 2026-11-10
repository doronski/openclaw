// Process supervisor tests cover lifecycle, restart, and termination behavior.
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnProcessAdapter } from "./types.js";

const { createChildAdapterMock, createPtyAdapterMock, createSystemdUserAdapterMock } = vi.hoisted(
  () => ({
    createChildAdapterMock: vi.fn(),
    createPtyAdapterMock: vi.fn(),
    createSystemdUserAdapterMock: vi.fn(),
  }),
);

vi.mock("./adapters/child.js", () => ({
  createChildAdapter: createChildAdapterMock,
}));

vi.mock("./adapters/pty.js", () => ({
  createPtyAdapter: createPtyAdapterMock,
}));

vi.mock("./adapters/systemd-user.js", async (importOriginal) => {
  const { resolveSystemdUserLimits } =
    await importOriginal<typeof import("./adapters/systemd-user.js")>();
  return { createSystemdUserAdapter: createSystemdUserAdapterMock, resolveSystemdUserLimits };
});

let createProcessSupervisor: typeof import("./supervisor.js").createProcessSupervisor;

type ProcessSupervisor = ReturnType<typeof createProcessSupervisor>;
type SpawnOptions = Parameters<ProcessSupervisor["spawn"]>[0];
type ChildSpawnOptions = Omit<Extract<SpawnOptions, { mode: "child" }>, "backendId" | "mode">;
type ChildAdapter = SpawnProcessAdapter<NodeJS.Signals | null>;
type StubChildAdapter = ChildAdapter & {
  emitStdout: (chunk: string) => void;
  emitStderr: (chunk: string) => void;
  settle: (code: number | null, signal?: NodeJS.Signals | null) => void;
  killMock: ReturnType<typeof vi.fn>;
  disposeMock: ReturnType<typeof vi.fn>;
};

function createWriteStdoutArgv(output: string): string[] {
  if (process.platform === "win32") {
    return [process.execPath, "-e", `process.stdout.write(${JSON.stringify(output)})`];
  }
  return ["/usr/bin/printf", "%s", output];
}

function createSilentIdleArgv(): string[] {
  return [process.execPath, "-e", "setInterval(() => {}, 1_000)"];
}

function createStubChildAdapter(options?: {
  pid?: number;
  onKill?: (signal: NodeJS.Signals | undefined, adapter: StubChildAdapter) => void;
}): StubChildAdapter {
  const stdoutListeners: Array<(chunk: string) => void> = [];
  const stderrListeners: Array<(chunk: string) => void> = [];
  let resolveWait:
    | ((value: { code: number | null; signal: NodeJS.Signals | null }) => void)
    | null = null;
  const waitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      resolveWait = resolve;
    },
  );
  const killMock = vi.fn();
  const disposeMock = vi.fn();
  const adapter: StubChildAdapter = {
    pid: options?.pid ?? 1234,
    stdin: undefined,
    onStdout: (listener) => {
      stdoutListeners.push(listener);
    },
    onStderr: (listener) => {
      stderrListeners.push(listener);
    },
    wait: async () => await waitPromise,
    kill: (signal) => {
      killMock(signal);
      options?.onKill?.(signal, adapter);
    },
    dispose: () => {
      disposeMock();
    },
    emitStdout: (chunk) => {
      for (const listener of stdoutListeners) {
        listener(chunk);
      }
    },
    emitStderr: (chunk) => {
      for (const listener of stderrListeners) {
        listener(chunk);
      }
    },
    settle: (code, signal = null) => {
      resolveWait?.({ code, signal });
      resolveWait = null;
    },
    killMock,
    disposeMock,
  };

  return adapter;
}

async function spawnChild(supervisor: ProcessSupervisor, options: ChildSpawnOptions) {
  return supervisor.spawn({
    ...options,
    backendId: "test",
    mode: "child",
  });
}

describe("process supervisor", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ createProcessSupervisor } = await import("./supervisor.js"));
    createChildAdapterMock.mockReset();
    createPtyAdapterMock.mockReset();
    createSystemdUserAdapterMock.mockReset();
    vi.useRealTimers();
  });

  it("routes configured commands through containment while retaining bounded output", async () => {
    const adapter = createStubChildAdapter();
    createSystemdUserAdapterMock.mockResolvedValue(adapter);
    const supervisor = createProcessSupervisor();
    const resourceLimits = { backend: "systemd-user" as const, slice: "commands.slice" };
    const run = await spawnChild(supervisor, {
      argv: ["/bin/sh", "-c", "printf output"],
      sessionId: "session-1",
      runId: "run-1",
      toolCallId: "tool-1",
      cwd: "/workspace",
      resourceLimits,
      maxCapturedOutputChars: 256,
    });
    expect(createSystemdUserAdapterMock).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceLimits,
        runId: "run-1",
        toolCallId: "tool-1",
        sessionId: "session-1",
      }),
    );
    expect(createChildAdapterMock).not.toHaveBeenCalled();
    adapter.emitStdout("x".repeat(1000));
    adapter.settle(0);
    const exit = await run.wait();
    expect(exit.stdout.length).toBeLessThanOrEqual(256);
    expect(exit.stdout).toContain("truncated");
  });

  it("does not fall back when a configured containment backend fails", async () => {
    createSystemdUserAdapterMock.mockRejectedValue(new Error("backend unavailable"));
    await expect(
      spawnChild(createProcessSupervisor(), {
        argv: ["/bin/true"],
        sessionId: "session-1",
        cwd: "/workspace",
        resourceLimits: { backend: "systemd-user", slice: "commands.slice" },
      }),
    ).rejects.toThrow("backend unavailable");
    expect(createChildAdapterMock).not.toHaveBeenCalled();
  });

  it.each([
    { timeoutMs: 9_000, timeoutSec: 2, expectedMs: 2_000 },
    { timeoutMs: 0, timeoutSec: 2, expectedMs: 2_000 },
    { timeoutMs: 1_000, timeoutSec: 2, expectedMs: 1_000 },
    { timeoutMs: undefined, timeoutSec: undefined, expectedMs: 60_000 },
    { timeoutMs: 90_000, timeoutSec: undefined, expectedMs: 60_000 },
  ])(
    "enforces the resolved contained budget (%j)",
    async ({ timeoutMs, timeoutSec, expectedMs }) => {
      vi.useFakeTimers();
      const nowSpy = vi.spyOn(performance, "now").mockReturnValue(1_000);
      const adapter = createStubChildAdapter({
        onKill: (signal, current) => current.settle(null, signal),
      });
      createSystemdUserAdapterMock.mockResolvedValue(adapter);
      const run = await spawnChild(createProcessSupervisor(), {
        argv: createSilentIdleArgv(),
        sessionId: "contained-budget",
        timeoutMs,
        resourceLimits: {
          backend: "systemd-user",
          slice: "commands.slice",
          ...(timeoutSec === undefined ? {} : { timeoutSec }),
        },
      });
      expect(createSystemdUserAdapterMock).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: expectedMs }),
      );
      await vi.advanceTimersByTimeAsync(expectedMs - 1);
      expect(adapter.killMock).not.toHaveBeenCalled();
      nowSpy.mockReturnValue(1_000 + expectedMs);
      await vi.advanceTimersByTimeAsync(1);
      await expect(run.wait()).resolves.toMatchObject({
        reason: "overall-timeout",
        timedOut: true,
      });
    },
  );

  it("retains a contained nonzero stop failure completed within its overall budget", async () => {
    vi.useFakeTimers();
    const nowSpy = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const adapter = createStubChildAdapter();
    createSystemdUserAdapterMock.mockResolvedValue(adapter);
    const run = await spawnChild(createProcessSupervisor(), {
      argv: createSilentIdleArgv(),
      sessionId: "contained-stop",
      timeoutMs: 9_000,
      resourceLimits: { backend: "systemd-user", slice: "commands.slice", timeoutSec: 8 },
    });
    nowSpy.mockReturnValue(2_500);
    adapter.settle(1);
    await expect(run.wait()).resolves.toMatchObject({
      reason: "exit",
      exitCode: 1,
      timedOut: false,
    });
    expect(adapter.killMock).not.toHaveBeenCalled();
  });

  it("recognizes the resource deadline before its timer callback runs", async () => {
    vi.useFakeTimers();
    const nowSpy = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const adapter = createStubChildAdapter();
    createSystemdUserAdapterMock.mockResolvedValue(adapter);
    const run = await spawnChild(createProcessSupervisor(), {
      argv: createSilentIdleArgv(),
      sessionId: "contained-elapsed",
      timeoutMs: 9_000,
      resourceLimits: { backend: "systemd-user", slice: "commands.slice", timeoutSec: 2 },
    });
    nowSpy.mockReturnValue(3_001);
    adapter.settle(1);
    await expect(run.wait()).resolves.toMatchObject({ reason: "overall-timeout", timedOut: true });
    expect(adapter.killMock).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "preserves the first contained cancellation cause (elapsed=%s)",
    async (elapsed) => {
      vi.useFakeTimers();
      const nowSpy = vi.spyOn(performance, "now").mockReturnValue(1_000);
      const adapter = createStubChildAdapter({
        onKill: (signal, current) => current.settle(null, signal),
      });
      createSystemdUserAdapterMock.mockResolvedValue(adapter);
      const run = await spawnChild(createProcessSupervisor(), {
        argv: createSilentIdleArgv(),
        sessionId: "contained-cancel",
        resourceLimits: { backend: "systemd-user", slice: "commands.slice", timeoutSec: 2 },
      });
      nowSpy.mockReturnValue(elapsed ? 3_001 : 1_500);
      run.cancel("manual-cancel");
      nowSpy.mockReturnValue(3_500);
      await expect(run.wait()).resolves.toMatchObject({
        reason: elapsed ? "overall-timeout" : "manual-cancel",
        timedOut: elapsed,
      });
    },
  );

  it("counts adapter startup against the contained budget and cancels a late adapter", async () => {
    vi.useFakeTimers();
    const nowSpy = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const adapter = createStubChildAdapter({
      onKill: (signal, current) => current.settle(null, signal),
    });
    let deliverAdapter!: (adapter: ChildAdapter) => void;
    createSystemdUserAdapterMock.mockReturnValue(
      new Promise<ChildAdapter>((resolve) => {
        deliverAdapter = resolve;
      }),
    );
    const supervisor = createProcessSupervisor();
    const spawning = spawnChild(supervisor, {
      argv: createSilentIdleArgv(),
      sessionId: "contained-startup",
      runId: "startup",
      timeoutMs: 9_000,
      resourceLimits: { backend: "systemd-user", slice: "commands.slice", timeoutSec: 1 },
    });
    nowSpy.mockReturnValue(2_001);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(supervisor.getRecord("startup")?.state).toBe("exiting");
    deliverAdapter(adapter);
    const run = await spawning;
    expect(adapter.killMock).toHaveBeenCalledWith("SIGTERM");
    await expect(run.wait()).resolves.toMatchObject({ reason: "overall-timeout", timedOut: true });
    expect(supervisor.getRecord("startup")?.state).toBe("exited");
  });

  it("clears the contained deadline when adapter startup fails", async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    createSystemdUserAdapterMock.mockRejectedValue(new Error("startup cleanup refused"));
    const timerCount = vi.getTimerCount();
    await expect(
      spawnChild(createProcessSupervisor(), {
        argv: createSilentIdleArgv(),
        sessionId: "contained-startup-error",
        resourceLimits: { backend: "systemd-user", slice: "commands.slice", timeoutSec: 1 },
      }),
    ).rejects.toThrow("startup cleanup refused");
    expect(vi.getTimerCount()).toBe(timerCount);
    expect(createChildAdapterMock).not.toHaveBeenCalled();
  });

  it("refuses PTY without retrying outside configured containment", async () => {
    await expect(
      createProcessSupervisor().spawn({
        mode: "pty",
        backendId: "exec-host",
        ptyCommand: "true",
        sessionId: "session-1",
        resourceLimits: { backend: "systemd-user", slice: "commands.slice" },
      }),
    ).rejects.toThrow("does not support PTY");
    expect(createPtyAdapterMock).not.toHaveBeenCalled();
    expect(createChildAdapterMock).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("spawns child runs and captures output", async () => {
    const adapter = createStubChildAdapter();
    createChildAdapterMock.mockResolvedValue(adapter);

    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "s1",
      argv: createWriteStdoutArgv("ok"),
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
    });

    adapter.emitStdout("ok");
    adapter.settle(0);

    const exit = await run.wait();
    expect(exit.reason).toBe("exit");
    expect(exit.exitCode).toBe(0);
    expect(exit.stdout).toBe("ok");
    expect(adapter.disposeMock).toHaveBeenCalledTimes(1);
  });

  it("enforces no-output timeout for silent processes", async () => {
    vi.useFakeTimers();
    const adapter = createStubChildAdapter({
      onKill: (signal, current) => {
        current.settle(null, signal ?? "SIGKILL");
      },
    });
    createChildAdapterMock.mockResolvedValue(adapter);

    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "s1",
      argv: createSilentIdleArgv(),
      timeoutMs: 300,
      noOutputTimeoutMs: 5,
      stdinMode: "pipe-closed",
    });

    const exitPromise = run.wait();
    await vi.advanceTimersByTimeAsync(5);

    const exit = await exitPromise;
    expect(adapter.killMock).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(adapter.killMock).not.toHaveBeenCalledWith("SIGKILL");
    expect(exit.reason).toBe("no-output-timeout");
    expect(exit.noOutputTimedOut).toBe(true);
    expect(exit.timedOut).toBe(true);
  });

  it.each([false, true])("honors cancellation grace (contained=%s)", async (contained) => {
    vi.useFakeTimers();
    const graceMs = contained ? 8_000 : 5_000;
    const adapter = createStubChildAdapter({
      onKill: (signal, current) => {
        if (signal === "SIGKILL") {
          current.settle(null, signal);
        }
      },
    });
    if (contained) {
      createSystemdUserAdapterMock.mockResolvedValue(adapter);
    } else {
      createChildAdapterMock.mockResolvedValue(adapter);
    }

    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "s1",
      argv: createSilentIdleArgv(),
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
      ...(contained
        ? {
            resourceLimits: {
              backend: "systemd-user" as const,
              slice: "commands.slice",
              killGraceSec: graceMs / 1000,
            },
          }
        : {}),
    });

    const exitPromise = run.wait();
    run.cancel("manual-cancel");

    expect(adapter.killMock).toHaveBeenCalledWith("SIGTERM");
    expect(adapter.killMock).not.toHaveBeenCalledWith("SIGKILL");

    await vi.advanceTimersByTimeAsync(graceMs - 1);
    expect(adapter.killMock).not.toHaveBeenCalledWith("SIGKILL");

    await vi.advanceTimersByTimeAsync(1);
    const exit = await exitPromise;
    expect(adapter.killMock).toHaveBeenCalledWith("SIGKILL");
    expect(exit.reason).toBe("manual-cancel");
    expect(exit.exitSignal).toBe("SIGKILL");
  });

  it("cancels prior scoped run when replaceExistingScope is enabled", async () => {
    const first = createStubChildAdapter({
      onKill: (signal, current) => {
        current.settle(null, signal ?? "SIGKILL");
      },
    });
    const second = createStubChildAdapter();
    createChildAdapterMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const supervisor = createProcessSupervisor();
    const firstRun = await spawnChild(supervisor, {
      sessionId: "s1",
      scopeKey: "scope:a",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 80)"],
      timeoutMs: 1_000,
      stdinMode: "pipe-open",
    });

    const secondRun = await spawnChild(supervisor, {
      sessionId: "s1",
      scopeKey: "scope:a",
      replaceExistingScope: true,
      argv: createWriteStdoutArgv("new"),
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
    });

    second.emitStdout("new");
    second.settle(0);

    const firstExit = await firstRun.wait();
    const secondExit = await secondRun.wait();
    expect(first.killMock).toHaveBeenCalledWith("SIGTERM");
    expect(["manual-cancel", "signal"]).toContain(firstExit.reason);
    expect(secondExit.reason).toBe("exit");
    expect(secondExit.stdout).toBe("new");
  });

  it("applies overall timeout even for near-immediate timer firing", async () => {
    vi.useFakeTimers();
    const adapter = createStubChildAdapter({
      onKill: (signal, current) => {
        current.settle(null, signal ?? "SIGKILL");
      },
    });
    createChildAdapterMock.mockResolvedValue(adapter);

    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "s-timeout",
      argv: createSilentIdleArgv(),
      timeoutMs: 1,
      stdinMode: "pipe-closed",
    });

    const exitPromise = run.wait();
    await vi.advanceTimersByTimeAsync(1);

    const exit = await exitPromise;
    expect(adapter.killMock).toHaveBeenCalledWith("SIGTERM");
    expect(exit.reason).toBe("overall-timeout");
    expect(exit.timedOut).toBe(true);
  });

  it("classifies a natural close after a missed overall deadline as timed out", async () => {
    vi.useFakeTimers();
    const nowSpy = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const adapter = createStubChildAdapter();
    createChildAdapterMock.mockResolvedValue(adapter);

    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "s-timeout-race",
      argv: createSilentIdleArgv(),
      timeoutMs: 10,
      stdinMode: "pipe-closed",
    });

    const exitPromise = run.wait();
    nowSpy.mockReturnValue(1_011);
    adapter.settle(0);

    const exit = await exitPromise;
    expect(adapter.killMock).not.toHaveBeenCalled();
    expect(exit.reason).toBe("overall-timeout");
    expect(exit.timedOut).toBe(true);
  });

  it("uses the refreshed no-output deadline when a missed timer races natural close", async () => {
    vi.useFakeTimers();
    const nowSpy = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const adapter = createStubChildAdapter();
    createChildAdapterMock.mockResolvedValue(adapter);

    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "s-no-output-race",
      argv: createSilentIdleArgv(),
      timeoutMs: 100,
      noOutputTimeoutMs: 10,
      stdinMode: "pipe-closed",
    });

    const exitPromise = run.wait();
    nowSpy.mockReturnValue(1_005);
    adapter.emitStdout("progress");
    nowSpy.mockReturnValue(1_016);
    adapter.settle(0);

    const exit = await exitPromise;
    expect(adapter.killMock).not.toHaveBeenCalled();
    expect(exit.reason).toBe("no-output-timeout");
    expect(exit.noOutputTimedOut).toBe(true);
    expect(exit.timedOut).toBe(true);
  });

  it("can stream output without retaining it in RunExit payload", async () => {
    const adapter = createStubChildAdapter();
    createChildAdapterMock.mockResolvedValue(adapter);

    const supervisor = createProcessSupervisor();
    let streamed = "";
    const run = await spawnChild(supervisor, {
      sessionId: "s-capture",
      argv: createWriteStdoutArgv("streamed"),
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
      captureOutput: false,
      onStdout: (chunk) => {
        streamed += chunk;
      },
    });

    adapter.emitStdout("streamed");
    adapter.settle(0);

    const exit = await run.wait();
    expect(streamed).toBe("streamed");
    expect(exit.stdout).toBe("");
  });

  it("bounds retained stdout and stderr while streaming full chunks", async () => {
    const adapter = createStubChildAdapter();
    createChildAdapterMock.mockResolvedValue(adapter);

    const supervisor = createProcessSupervisor();
    let streamedStdout = "";
    let streamedStderr = "";
    const stdoutChunk = `${"a".repeat(300)}stdout-tail`;
    const stderrChunk = `${"b".repeat(300)}stderr-tail`;
    const run = await spawnChild(supervisor, {
      sessionId: "s-capture-cap",
      argv: createWriteStdoutArgv(stdoutChunk),
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
      maxCapturedOutputChars: 256,
      onStdout: (chunk) => {
        streamedStdout += chunk;
      },
      onStderr: (chunk) => {
        streamedStderr += chunk;
      },
    });

    adapter.emitStdout(stdoutChunk);
    adapter.emitStderr(stderrChunk);
    adapter.settle(0);

    const exit = await run.wait();
    expect(streamedStdout).toBe(stdoutChunk);
    expect(streamedStderr).toBe(stderrChunk);
    expect(exit.stdout.length).toBeLessThanOrEqual(256);
    expect(exit.stderr.length).toBeLessThanOrEqual(256);
    expect(exit.stdout).toContain("captured stdout truncated");
    expect(exit.stderr).toContain("captured stderr truncated");
    expect(exit.stdout.endsWith("stdout-tail")).toBe(true);
    expect(exit.stderr.endsWith("stderr-tail")).toBe(true);
  });
});
