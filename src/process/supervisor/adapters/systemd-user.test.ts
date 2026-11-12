import { addAbortSignal, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnInput } from "../types.js";
import { createSystemdUserAdapter } from "./systemd-user.js";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  readFile: vi.fn(),
  createReadStream: vi.fn(),
  createChildAdapter: vi.fn(),
  emitDiagnosticEvent: vi.fn(),
}));
vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));
vi.mock("node:fs", () => ({ createReadStream: mocks.createReadStream }));
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
  let meminfo: string;
  let memoryPressure: string;
  let workloadCgroup: string;
  let ancestorMetrics: Map<string, string | Error>;
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
  const metricValue = (file: string): string => {
    if (file === "/proc/meminfo") {
      return meminfo;
    }
    if (file === "/proc/pressure/memory") {
      return memoryPressure;
    }
    if (file === `/sys/fs/cgroup${workloadCgroup}/memory.max`) {
      return sliceMemory;
    }
    const value = ancestorMetrics.get(file);
    if (value instanceof Error) {
      throw value;
    }
    if (value === undefined) {
      throw new Error("private unavailable ancestor metric");
    }
    return value;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    serviceResult = "success";
    populated = false;
    sliceMemory = "4294967296";
    meminfo = "MemAvailable: 6291456 kB\n";
    memoryPressure =
      "some avg10=1.00 avg60=0.50 avg300=0.10 total=123\nfull avg10=0.50 avg60=0.20 avg300=0.00 total=12\n";
    controlAvailable = true;
    stopSucceeds = true;
    selfCgroup = "/user.slice/app.slice/gateway.service";
    serviceObserved = true;
    servicePid = "1234";
    serviceCgroup = undefined;
    workloadCgroup = "/user.slice/commands.slice";
    ancestorMetrics = new Map([["/sys/fs/cgroup/user.slice/memory.max", "max"]]);
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
            ? `LoadState=loaded\nActiveState=active\nControlGroup=${workloadCgroup}\n`
            : `LoadState=loaded\nActiveState=${stopSucceeds ? "inactive" : "active"}\nControlGroup=${serviceCgroup ?? `${workloadCgroup}/${args.at(-1)}`}\nExecMainPID=${servicePid}\nMemoryPeak=4096\nResult=${serviceResult}\n`,
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
    mocks.createReadStream.mockImplementation((file: string, options: { signal: AbortSignal }) => {
      const value = metricValue(file);
      return addAbortSignal(options.signal, Readable.from([Buffer.from(value)]));
    });
  });
  afterEach(() => {
    killLauncher.mockReset();
    vi.unstubAllGlobals();
    vi.useRealTimers();
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
    expect(mocks.createReadStream).not.toHaveBeenCalled();
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

  const admittedInput = () => ({
    ...input(),
    resourceLimits: {
      backend: "systemd-user" as const,
      slice: "commands.slice",
      hostMemoryAdmission: { minAvailableBytes: 2_147_483_648, maxFullPressureAvg10: 0.5 },
    },
  });

  it("admits at exact aggregate-plus-headroom and full PSI boundaries without changing job limits", async () => {
    const adapter = await createSystemdUserAdapter(admittedInput());
    expect(mocks.createChildAdapter).toHaveBeenCalledOnce();
    expect(mocks.createChildAdapter.mock.calls[0][0].argv).toEqual(
      expect.arrayContaining([
        "--property=MemoryMax=2147483648",
        "--property=RuntimeMaxSec=60s",
        "--property=TasksMax=128",
      ]),
    );
    expect(mocks.createReadStream.mock.calls.map(([file]) => file)).toEqual([
      "/sys/fs/cgroup/user.slice/commands.slice/memory.max",
      "/proc/meminfo",
      "/proc/pressure/memory",
      "/sys/fs/cgroup/user.slice/memory.max",
    ]);
    for (const [, options] of mocks.createReadStream.mock.calls) {
      expect(options).toMatchObject({ start: 0, end: 65536, highWaterMark: 65537 });
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
    finish({ code: 0, signal: null });
    await adapter.wait();
    adapter.dispose();
  });

  it.each([
    ["headroom", "MemAvailable: 6291455 kB\n", "full avg10=0.50 avg60=0.00 avg300=0.00 total=0\n"],
    ["pressure", "MemAvailable: 6291456 kB\n", "full avg10=0.51 avg60=0.00 avg300=0.00 total=0\n"],
  ])(
    "refuses host memory %s before launching and emits only a fixed diagnostic",
    async (reason, available, pressure) => {
      meminfo = available;
      memoryPressure = pressure;
      await expect(createSystemdUserAdapter(admittedInput())).rejects.toThrow(
        `host_memory_${reason}`,
      );
      expect(mocks.createChildAdapter).not.toHaveBeenCalled();
      expect(argsCalls().some((args) => args[2] === "stop")).toBe(false);
      expect(mocks.emitDiagnosticEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: "refused",
          result: `host_memory_${reason}`,
          exitCode: null,
        }),
      );
      const diagnostics = JSON.stringify(mocks.emitDiagnosticEvent.mock.calls);
      for (const value of [
        "private-value",
        "private-manager-value",
        "printf",
        "MemAvailable",
        "avg10",
      ]) {
        expect(diagnostics).not.toContain(value);
      }
      expect(mocks.emitDiagnosticEvent.mock.calls[0][0]).not.toHaveProperty("cleanupVerified");
    },
  );

  it("does not give concurrent launches independent claims on the same host headroom", async () => {
    // Each 2 GiB command would fit beside 2 GiB headroom; the whole 4 GiB slice would not.
    meminfo = "MemAvailable: 5242880 kB\n";
    const results = await Promise.allSettled([
      createSystemdUserAdapter(admittedInput()),
      createSystemdUserAdapter(admittedInput()),
    ]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(mocks.createChildAdapter).not.toHaveBeenCalled();
    expect(mocks.readFile.mock.calls.some(([file]) => file.endsWith("memory.current"))).toBe(false);
  });

  it.each([
    ["missing available", "", undefined],
    ["duplicate available", "MemAvailable: 6291456 kB\nMemAvailable: 1 kB\n", undefined],
    ["wrong units", "MemAvailable: 6291456 MB\n", undefined],
    ["unsafe available", "MemAvailable: 9007199254740991 kB\n", undefined],
    ["oversized", "x".repeat(65537), undefined],
    ["missing full PSI", undefined, "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n"],
    [
      "duplicate full PSI",
      undefined,
      "full avg10=0 avg60=0 avg300=0 total=0\nfull avg10=0 avg60=0 avg300=0 total=0\n",
    ],
    ["nonfinite PSI", undefined, "full avg10=NaN avg60=0 avg300=0 total=0\n"],
    ["out of range PSI", undefined, "full avg10=0 avg60=101 avg300=0 total=0\n"],
  ])("fails closed on %s metrics only when enabled", async (_name, available, pressure) => {
    meminfo = available ?? meminfo;
    memoryPressure = pressure ?? memoryPressure;
    await expect(createSystemdUserAdapter(admittedInput())).rejects.toThrow(
      "host_memory_metrics_unavailable",
    );
    expect(mocks.createChildAdapter).not.toHaveBeenCalled();
  });

  it("rechecks the current aggregate limit before admission", async () => {
    mocks.createReadStream.mockImplementation((file: string) =>
      Readable.from([
        Buffer.from(
          file === "/sys/fs/cgroup/user.slice/commands.slice/memory.max"
            ? "8589934592"
            : metricValue(file),
        ),
      ]),
    );
    await expect(createSystemdUserAdapter(admittedInput())).rejects.toThrow("host_memory_headroom");
    expect(mocks.createChildAdapter).not.toHaveBeenCalled();
  });

  it("fails closed when the aggregate budget cannot be represented safely", async () => {
    sliceMemory = "9007199254740992";
    await expect(createSystemdUserAdapter(admittedInput())).rejects.toThrow(
      "host_memory_metrics_unavailable",
    );
    expect(mocks.createChildAdapter).not.toHaveBeenCalled();
  });

  it.each([
    ["8589934592", "2147483648"],
    ["9007199254740993", "9007192812290049"],
  ])(
    "admits exact finite ancestor headroom using integer bytes (%s minus %s)",
    async (maximum, current) => {
      ancestorMetrics.set("/sys/fs/cgroup/user.slice/memory.max", maximum);
      ancestorMetrics.set("/sys/fs/cgroup/user.slice/memory.current", current);
      const adapter = await createSystemdUserAdapter(admittedInput());
      expect(mocks.createChildAdapter).toHaveBeenCalledOnce();
      expect(
        mocks.createReadStream.mock.calls.some(
          ([file]) => file === "/sys/fs/cgroup/user.slice/commands.slice/memory.current",
        ),
      ).toBe(false);
      finish({ code: 0, signal: null });
      await adapter.wait();
      adapter.dispose();
    },
  );

  it.each([
    ["one byte short", "8589934592", "2147483649", "headroom"],
    ["usage includes descendants", "8589934592", "4294967296", "headroom"],
    ["zero limit", "0", "0", "headroom"],
    ["malformed limit", "private-invalid", "0", "metrics_unavailable"],
    ["malformed usage", "8589934592", "-1", "metrics_unavailable"],
    ["unreadable limit", new Error("private-value"), "0", "metrics_unavailable"],
    ["unreadable usage", "8589934592", new Error("private-value"), "metrics_unavailable"],
  ])(
    "refuses a finite ancestor with %s before launch",
    async (_reason, maximum, current, refusal) => {
      ancestorMetrics.set("/sys/fs/cgroup/user.slice/memory.max", maximum);
      ancestorMetrics.set("/sys/fs/cgroup/user.slice/memory.current", current);
      await expect(createSystemdUserAdapter(admittedInput())).rejects.toThrow(
        `host_memory_${refusal}`,
      );
      expect(mocks.createChildAdapter).not.toHaveBeenCalled();
      expect(argsCalls().some((args) => args[2] === "stop")).toBe(false);
      expect(JSON.stringify(mocks.emitDiagnosticEvent.mock.calls)).not.toContain("private-value");
      expect(JSON.stringify(mocks.emitDiagnosticEvent.mock.calls)).not.toContain("private-invalid");
    },
  );

  it.each([1, 64, 65])(
    "bounds the cgroup hierarchy at depth %i without reading root memory files",
    async (depth) => {
      const components = [
        ...Array.from({ length: depth - 1 }, () => "nested.slice"),
        "commands.slice",
      ];
      workloadCgroup = `/${components.join("/")}`;
      for (let count = 1; count < components.length; count++) {
        ancestorMetrics.set(
          `/sys/fs/cgroup/${components.slice(0, count).join("/")}/memory.max`,
          "max",
        );
      }
      if (depth > 64) {
        await expect(createSystemdUserAdapter(admittedInput())).rejects.toThrow(
          "host_memory_metrics_unavailable",
        );
        expect(mocks.createReadStream).not.toHaveBeenCalled();
        expect(mocks.createChildAdapter).not.toHaveBeenCalled();
      } else {
        const adapter = await createSystemdUserAdapter(admittedInput());
        expect(mocks.createReadStream).toHaveBeenCalledTimes(3 + depth - 1);
        finish({ code: 0, signal: null });
        await adapter.wait();
        adapter.dispose();
      }
      expect(
        mocks.createReadStream.mock.calls.some(
          ([file]) =>
            file === "/sys/fs/cgroup/memory.max" || file === "/sys/fs/cgroup/memory.current",
        ),
      ).toBe(false);
    },
  );

  it("refuses an unreadable second finite ancestor after all started readers close", async () => {
    workloadCgroup = "/user.slice/nested.slice/commands.slice";
    ancestorMetrics.set("/sys/fs/cgroup/user.slice/memory.max", "8589934592");
    ancestorMetrics.set("/sys/fs/cgroup/user.slice/memory.current", new Error("private-value"));
    ancestorMetrics.set("/sys/fs/cgroup/user.slice/nested.slice/memory.max", "8589934592");
    ancestorMetrics.set("/sys/fs/cgroup/user.slice/nested.slice/memory.current", "0");
    const streams: Readable[] = [];
    mocks.createReadStream.mockImplementation((file: string, options: { signal: AbortSignal }) => {
      const stream = addAbortSignal(
        options.signal,
        Readable.from([Buffer.from(metricValue(file))]),
      );
      streams.push(stream);
      return stream;
    });
    await expect(createSystemdUserAdapter(admittedInput())).rejects.toThrow(
      "host_memory_metrics_unavailable",
    );
    expect(streams).toHaveLength(6);
    expect(streams.every((stream) => stream.closed)).toBe(true);
    expect(mocks.createChildAdapter).not.toHaveBeenCalled();
  });

  it("does not start metric readers after the startup budget has expired", async () => {
    vi.useFakeTimers();
    const original = mocks.execFile.getMockImplementation();
    mocks.execFile.mockImplementation((file, args, options, callback) => {
      if (args[2] === "show-environment") {
        vi.setSystemTime(Date.now() + 100);
      }
      return original?.(file, args, options, callback);
    });
    await expect(createSystemdUserAdapter({ ...admittedInput(), timeoutMs: 100 })).rejects.toThrow(
      "service did not start before its deadline",
    );
    expect(mocks.createReadStream).not.toHaveBeenCalled();
    expect(mocks.createChildAdapter).not.toHaveBeenCalled();
  });

  it("gives startup expiry precedence over metric refusal after closing readers", async () => {
    vi.useFakeTimers();
    meminfo = "private-invalid";
    const streams: Readable[] = [];
    mocks.createReadStream.mockImplementation((file: string, options: { signal: AbortSignal }) => {
      vi.setSystemTime(Date.now() + 100);
      const stream = addAbortSignal(
        options.signal,
        Readable.from([Buffer.from(metricValue(file))]),
      );
      streams.push(stream);
      return stream;
    });
    await expect(createSystemdUserAdapter({ ...admittedInput(), timeoutMs: 100 })).rejects.toThrow(
      "service did not start before its deadline",
    );
    expect(streams).toHaveLength(1);
    expect(streams.every((stream) => stream.closed)).toBe(true);
    expect(mocks.createChildAdapter).not.toHaveBeenCalled();
    expect(mocks.emitDiagnosticEvent).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([100, undefined])(
    "bounds stalled metric reads with a %s ms command budget and closes streams",
    async (timeoutMs) => {
      vi.useFakeTimers();
      const streams: Readable[] = [];
      mocks.createReadStream.mockImplementation(
        (_file: string, options: { signal: AbortSignal }) => {
          const stream = addAbortSignal(options.signal, new Readable({ read() {} }));
          streams.push(stream);
          return stream;
        },
      );
      const result = expect(
        createSystemdUserAdapter({ ...admittedInput(), timeoutMs }),
      ).rejects.toThrow(
        timeoutMs === undefined
          ? "host_memory_metrics_unavailable"
          : "service did not start before its deadline",
      );
      await vi.advanceTimersByTimeAsync(timeoutMs ?? 1000);
      await result;
      expect(streams).toHaveLength(4);
      expect(streams.every((stream) => stream.closed)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(mocks.createChildAdapter).not.toHaveBeenCalled();
    },
  );

  it.each([100, 200])(
    "rejects before launch when valid metrics take %i ms of a 100 ms budget",
    async (elapsedMs) => {
      vi.useFakeTimers();
      const streams: Readable[] = [];
      mocks.createReadStream.mockImplementation(
        (file: string, options: { signal: AbortSignal }) => {
          const value = metricValue(file);
          let dataTimer: ReturnType<typeof setTimeout> | undefined;
          const stream = addAbortSignal(
            options.signal,
            new Readable({
              read() {
                dataTimer = setTimeout(() => {
                  this.push(Buffer.from(value));
                  this.push(null);
                }, elapsedMs);
              },
              destroy(error, callback) {
                clearTimeout(dataTimer);
                callback(error);
              },
            }),
          );
          streams.push(stream);
          return stream;
        },
      );
      const result = expect(
        createSystemdUserAdapter({ ...admittedInput(), timeoutMs: 100 }),
      ).rejects.toThrow("service did not start before its deadline");
      await vi.advanceTimersByTimeAsync(100);
      await result;
      expect(streams).toHaveLength(4);
      expect(streams.every((stream) => stream.closed)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(mocks.createChildAdapter).not.toHaveBeenCalled();
      expect(argsCalls().some((args) => args[2] === "stop")).toBe(false);
    },
  );

  it("does not disclose metric read errors", async () => {
    mocks.createReadStream.mockImplementation(() => {
      throw new Error("private-value");
    });
    await expect(createSystemdUserAdapter(admittedInput())).rejects.toThrow(
      "host_memory_metrics_unavailable",
    );
    expect(JSON.stringify(mocks.emitDiagnosticEvent.mock.calls)).not.toContain("private-value");
    expect(mocks.createChildAdapter).not.toHaveBeenCalled();
  });

  it.each([
    { minAvailableBytes: 0, maxFullPressureAvg10: 1 },
    { minAvailableBytes: 0.5, maxFullPressureAvg10: 1 },
    { minAvailableBytes: Number.MAX_SAFE_INTEGER + 1, maxFullPressureAvg10: 1 },
    { minAvailableBytes: 1, maxFullPressureAvg10: NaN },
    { minAvailableBytes: 1, maxFullPressureAvg10: Infinity },
    { minAvailableBytes: 1, maxFullPressureAvg10: -1 },
    { minAvailableBytes: 1, maxFullPressureAvg10: 101 },
  ])("rejects invalid admission policy before reading metrics: %j", async (hostMemoryAdmission) => {
    const invocation = admittedInput();
    invocation.resourceLimits.hostMemoryAdmission = hostMemoryAdmission;
    await expect(createSystemdUserAdapter(invocation)).rejects.toThrow("Invalid exec");
    expect(mocks.createReadStream).not.toHaveBeenCalled();
    expect(mocks.createChildAdapter).not.toHaveBeenCalled();
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
    servicePid = "0";
    finish({ code: 0, signal: null });
    await adapter.wait();
    expect(mocks.emitDiagnosticEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ childPid: 1234, toolCallId: "tool-1", cleanupVerified: true }),
    );
    adapter.dispose();
  });

  it("retains trusted --wait success when a short service unloads before observation", async () => {
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
