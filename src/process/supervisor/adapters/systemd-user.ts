import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExecResourceLimitsConfig } from "../../../config/types.tools.js";
import { emitDiagnosticEvent } from "../../../infra/diagnostic-events.js";
import type { SpawnInput, SpawnProcessAdapter } from "../types.js";
import { createChildAdapter } from "./child.js";

const SYSTEMCTL = "/usr/bin/systemctl";
const SYSTEMD_RUN = "/usr/bin/systemd-run";
const CONTROL_TIMEOUT_MS = 10_000;
const CGROUP_ROOT = "/sys/fs/cgroup";
const HOST_METRIC_TIMEOUT_MS = 1_000;
const HOST_METRIC_MAX_BYTES = 64 * 1024;
const DEFAULT_LIMITS = {
  memoryHighBytes: 1_073_741_824,
  memoryMaxBytes: 2_147_483_648,
  memorySwapMaxBytes: 0,
  tasksMax: 128,
  timeoutSec: 60,
  killGraceSec: 5,
};

type Limits = ExecResourceLimitsConfig & typeof DEFAULT_LIMITS;
type Properties = Record<string, string>;
type Input = Extract<SpawnInput, { mode: "child" }> & { runId: string };

export function resolveSystemdUserLimits(config: ExecResourceLimitsConfig): Limits {
  const limits = { ...DEFAULT_LIMITS, ...config };
  const admission = limits.hostMemoryAdmission;
  if (
    limits.backend !== "systemd-user" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]*\.slice$/.test(limits.slice) ||
    Object.entries(DEFAULT_LIMITS).some(([key]) => {
      const value = limits[key as keyof typeof DEFAULT_LIMITS];
      return !Number.isSafeInteger(value) || value < (key === "memorySwapMaxBytes" ? 0 : 1);
    }) ||
    limits.memoryHighBytes > limits.memoryMaxBytes ||
    limits.timeoutSec > 2_147_483 ||
    limits.killGraceSec > 2_147_483 ||
    (admission !== undefined &&
      (!admission ||
        !Number.isSafeInteger(admission.minAvailableBytes) ||
        admission.minAvailableBytes <= 0 ||
        !Number.isFinite(admission.maxFullPressureAvg10) ||
        admission.maxFullPressureAvg10 < 0 ||
        admission.maxFullPressureAvg10 > 100))
  ) {
    throw new Error("Invalid exec systemd-user resourceLimits");
  }
  if (admission) {
    limits.hostMemoryAdmission = { ...admission };
  }
  return limits;
}

// Control diagnostics must not echo manager environment values or command argv.
function control(
  args: string[],
  timeout = CONTROL_TIMEOUT_MS,
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      SYSTEMCTL,
      ["--user", "--no-ask-password", ...args],
      {
        encoding: "utf8",
        timeout: Math.min(timeout, 2_147_483_647),
        killSignal: "SIGKILL",
        maxBuffer: 256 * 1024,
        env: process.env,
      },
      (error, stdout) => resolve({ ok: !error, stdout }),
    );
  });
}

async function show(unit: string): Promise<Properties> {
  const result = await control([
    "show",
    "--property=LoadState,ActiveState,ControlGroup,ExecMainPID,ExecMainCode,ExecMainStatus,Result,MemoryPeak",
    unit,
  ]);
  const properties = Object.fromEntries(
    result.stdout.split("\n").flatMap((line) => {
      const separator = line.indexOf("=");
      return separator < 0 ? [] : [[line.slice(0, separator), line.slice(separator + 1)]];
    }),
  );
  if (!result.ok && properties.LoadState !== "not-found") {
    throw new Error("exec systemd-user backend unavailable: cannot inspect unit");
  }
  return properties;
}

function cgroupDirectory(controlGroup: string): string {
  if (!controlGroup.startsWith("/") || controlGroup.split("/").includes("..")) {
    throw new Error("exec systemd-user backend returned an invalid cgroup");
  }
  return path.join(CGROUP_ROOT, controlGroup);
}

async function readCgroup(directory: string, file: string): Promise<string | undefined> {
  try {
    return (await fs.readFile(path.join(directory, file), "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new Error("exec systemd-user backend cannot verify cgroup resources", { cause: error });
  }
}

async function requireWorkloadSlice(slice: string): Promise<string> {
  const properties = await show(slice);
  if (properties.ActiveState !== "active" || !properties.ControlGroup) {
    throw new Error("exec resourceLimits requires an active, preconfigured workload slice");
  }
  const selfMembership = await fs.readFile("/proc/self/cgroup", "utf8");
  const selfCgroup = selfMembership
    .split("\n")
    .find((line) => line.startsWith("0::"))
    ?.slice(3);
  if (!selfCgroup) {
    throw new Error("exec resourceLimits requires a verifiable cgroup v2 owner");
  }
  if (
    properties.ControlGroup === "/" ||
    selfCgroup === properties.ControlGroup ||
    selfCgroup.startsWith(`${properties.ControlGroup}/`)
  ) {
    throw new Error("exec workload slice must not contain the gateway command owner");
  }
  const directory = cgroupDirectory(properties.ControlGroup);
  const [memory, tasks] = await Promise.all([
    readCgroup(directory, "memory.max"),
    readCgroup(directory, "pids.max"),
  ]);
  if (![memory, tasks].every((value) => value && /^[1-9][0-9]*$/.test(value))) {
    throw new Error(
      "exec workload slice requires finite cgroup v2 memory.max and pids.max budgets",
    );
  }
  return properties.ControlGroup;
}

function finiteNumber(value: string | undefined): number | undefined {
  if (!value || !/^[0-9]+$/.test(value)) {
    return undefined;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

async function readHostMetric(file: string): Promise<string> {
  const controller = new AbortController();
  const stream = createReadStream(file, {
    start: 0,
    // end is inclusive: the extra byte detects oversized input without reading it all.
    end: HOST_METRIC_MAX_BYTES,
    highWaterMark: HOST_METRIC_MAX_BYTES + 1,
    signal: controller.signal,
  });
  const timeout = setTimeout(() => controller.abort(), HOST_METRIC_TIMEOUT_MS);
  timeout.unref();
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk)) {
        throw new Error("Invalid host metric bytes");
      }
      bytes += chunk.length;
      if (bytes > HOST_METRIC_MAX_BYTES) {
        throw new Error("Host metric exceeds read bound");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    clearTimeout(timeout);
    stream.destroy();
  }
}

async function hostMemoryRefusal(
  policy: NonNullable<Limits["hostMemoryAdmission"]>,
  sliceCgroup: string,
): Promise<"host_memory_metrics_unavailable" | "host_memory_headroom" | "host_memory_pressure" | undefined> {
  try {
    // Re-read the aggregate limit immediately before admission, not the earlier slice check.
    const reads = await Promise.allSettled([
      readHostMetric(path.join(cgroupDirectory(sliceCgroup), "memory.max")),
      readHostMetric("/proc/meminfo"),
      readHostMetric("/proc/pressure/memory"),
    ]);
    if (reads.some((read) => read.status === "rejected")) {
      return "host_memory_metrics_unavailable";
    }
    const [memoryMax, meminfo, pressure] = reads.map((read) =>
      read.status === "fulfilled" ? read.value : "",
    );
    const aggregateBytes = finiteNumber(memoryMax.trim());
    const availableLines = meminfo.split("\n").filter((line) => line.startsWith("MemAvailable:"));
    const availableMatch = availableLines.length === 1
      ? /^MemAvailable:\s+([0-9]+)\s+kB$/.exec(availableLines[0])
      : null;
    const availableKiB = finiteNumber(availableMatch?.[1]);
    const availableBytes = availableKiB === undefined ? undefined : availableKiB * 1024;
    const fullLines = pressure.split("\n").filter((line) => /^full(?:\s|$)/.test(line));
    const full = fullLines.length === 1
      ? /^full avg10=([0-9]+(?:\.[0-9]+)?) avg60=([0-9]+(?:\.[0-9]+)?) avg300=([0-9]+(?:\.[0-9]+)?) total=[0-9]+$/.exec(fullLines[0])
      : null;
    if (
      !aggregateBytes ||
      availableBytes === undefined ||
      !Number.isSafeInteger(availableBytes) ||
      !full ||
      full.slice(1).some((value) => !Number.isFinite(Number(value)) || Number(value) > 100)
    ) {
      return "host_memory_metrics_unavailable";
    }
    // Reserve the entire finite aggregate, including concurrent not-yet-charged jobs.
    // Subtracting a separately sampled memory.current would permit release/recharge races.
    if (BigInt(availableBytes) < BigInt(policy.minAvailableBytes) + BigInt(aggregateBytes)) {
      return "host_memory_headroom";
    }
    return Number(full[1]) > policy.maxFullPressureAvg10 ? "host_memory_pressure" : undefined;
  } catch {
    // Never expose raw file contents, errors, command arguments, or environment values.
    return "host_memory_metrics_unavailable";
  }
}

/** Own only the command service: the gateway and model runner stay outside its cgroup. */
export async function createSystemdUserAdapter(input: Input): Promise<SpawnProcessAdapter> {
  if (process.platform !== "linux" || !input.resourceLimits || !input.cwd) {
    throw new Error(
      "exec systemd-user resourceLimits requires Linux and an explicit working directory",
    );
  }
  if (input.windowsVerbatimArguments || input.argv.length === 0) {
    throw new Error("exec systemd-user resourceLimits does not support this invocation");
  }
  const limits = resolveSystemdUserLimits(input.resourceLimits);
  const sliceCgroup = await requireWorkloadSlice(limits.slice);
  const unit = `openclaw-exec-${randomUUID()}.service`;
  const expectedCgroup = `${sliceCgroup}/${unit}`;
  const directory = cgroupDirectory(expectedCgroup);
  const timeoutMs = Math.min(input.timeoutMs ?? Infinity, limits.timeoutSec * 1000);
  const startedAtMs = Date.now();
  const startupDeadline = startedAtMs + Math.min(timeoutMs, CONTROL_TIMEOUT_MS);
  const env = input.env ?? process.env;
  const names = Object.keys(env).filter((name) => env[name] !== undefined);
  if (names.some((name) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))) {
    throw new Error("exec systemd-user resourceLimits received an invalid environment name");
  }
  for (const name of ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "SYSTEMD_BUS_ADDRESS"]) {
    if (env[name] !== undefined && env[name] !== process.env[name]) {
      throw new Error("exec resourceLimits cannot override the user-service manager transport");
    }
  }
  const launcherEnv = {
    ...env,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    SYSTEMD_BUS_ADDRESS: process.env.SYSTEMD_BUS_ADDRESS,
  };
  const managerEnvironment = await control(["show-environment"]);
  if (!managerEnvironment.ok) {
    throw new Error("exec systemd-user backend unavailable: cannot isolate service environment");
  }
  const unsetNames = managerEnvironment.stdout.split("\n").flatMap((line) => {
    const match = /^([a-zA-Z_][a-zA-Z0-9_]*)=/.exec(line);
    return match && !names.includes(match[1]) ? [match[1]] : [];
  });
  const argv = [
    SYSTEMD_RUN,
    "--user",
    "--no-ask-password",
    "--quiet",
    "--pipe",
    "--wait",
    "--service-type=exec",
    "--expand-environment=no",
    `--unit=${unit}`,
    "--description=OpenClaw exec command",
    `--slice=${limits.slice}`,
    `--working-directory=${input.cwd}`,
    `--property=MemoryHigh=${limits.memoryHighBytes}`,
    `--property=MemoryMax=${limits.memoryMaxBytes}`,
    `--property=MemorySwapMax=${limits.memorySwapMaxBytes}`,
    `--property=TasksMax=${limits.tasksMax}`,
    `--property=RuntimeMaxSec=${timeoutMs / 1000}s`,
    `--property=TimeoutStartSec=${timeoutMs / 1000}s`,
    `--property=TimeoutStopSec=${limits.killGraceSec}s`,
    "--property=KillMode=control-group",
    "--property=SendSIGKILL=yes",
    "--property=MemoryAccounting=yes",
    "--property=OOMPolicy=kill",
    "--property=TasksAccounting=yes",
    ...(unsetNames.length ? [`--property=UnsetEnvironment=${unsetNames.join(" ")}`] : []),
    // Copy values via the client's environment, never via argv or diagnostic events.
    ...names.map((name) => `--setenv=${name}`),
    "--",
    ...input.argv,
  ];
  if (limits.hostMemoryAdmission) {
    const refusal = await hostMemoryRefusal(limits.hostMemoryAdmission, sliceCgroup);
    if (refusal) {
      emitDiagnosticEvent({
        type: "exec.process.containment",
        phase: "refused",
        runId: input.runId,
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        unit,
        expectedCgroup,
        startedAtMs,
        endedAtMs: Date.now(),
        result: refusal,
        exitCode: null,
      });
      throw new Error(`exec systemd-user host memory admission refused: ${refusal}`);
    }
  }
  if (Date.now() >= startupDeadline) {
    throw new Error("exec systemd-user service did not start before its deadline");
  }
  const child = await createChildAdapter({
    argv,
    cwd: input.cwd,
    env: launcherEnv,
    input: input.input,
    stdinMode: input.stdinMode,
  });
  const childExit = child.wait();
  type LauncherState =
    | { status: "running" }
    | { status: "exited"; exit: Awaited<ReturnType<typeof child.wait>> }
    | { status: "error" };
  let launcherState: LauncherState = { status: "running" };
  const getLauncherState = (): LauncherState => launcherState;
  void childExit.then(
    (exit) => {
      launcherState = { status: "exited", exit };
    },
    () => {
      launcherState = { status: "error" };
    },
  );
  let lastProperties: Properties = {};
  let observedCgroup: string | undefined;
  let observedChildPid: number | undefined;
  let observedMemoryPeak: number | undefined;
  let finished = false;
  let stopPromise: Promise<void> | undefined;
  let controlFailure = false;
  const recordCgroup = (properties: Properties) => {
    if (properties.ControlGroup) {
      observedCgroup = properties.ControlGroup;
    }
    if (observedCgroup !== undefined && observedCgroup !== expectedCgroup) {
      throw new Error("exec systemd-user service cgroup does not match its workload slice");
    }
  };
  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      const stopped = await control(
        ["stop", unit],
        limits.killGraceSec * 1000 + CONTROL_TIMEOUT_MS,
      );
      if (!stopped.ok) {
        const properties = await show(unit);
        recordCgroup(properties);
        if (
          properties.LoadState !== "not-found" &&
          properties.ActiveState !== "inactive" &&
          properties.ActiveState !== "failed"
        ) {
          throw new Error("exec systemd-user service could not be stopped");
        }
      }
      recordCgroup(lastProperties);
      // cgroup.events includes nested cgroups: checking only the main PID would
      // miss daemonized descendants which retained this command's budget.
      const events = await readCgroup(directory, "cgroup.events");
      if (events !== undefined && !/^populated 0$/m.test(events)) {
        throw new Error("exec systemd-user cgroup is still populated after stop");
      }
      const launcher = getLauncherState();
      const waitedForSuccessfulService =
        launcher.status === "exited" && launcher.exit.code === 0 && launcher.exit.signal === null;
      // A missing path alone proves nothing before activation. Bind absence to
      // the exact observed unit, successful StopUnit, or systemd-run --wait success.
      if (!stopped.ok && lastProperties.LoadState !== "loaded" && !waitedForSuccessfulService) {
        throw new Error("exec systemd-user cannot verify cleanup of an unobserved service");
      }
    })().finally(() => {
      // Service control and cgroup checks own cleanup verification. Hard-kill a
      // stuck launcher through the child adapter's bounded wait; its exit must
      // not turn failed service cleanup into verified completion.
      if (getLauncherState().status === "running") {
        child.kill("SIGKILL");
      }
    });
    return stopPromise;
  };
  const observe = async () => {
    try {
      const properties = await show(unit);
      if (properties.LoadState !== "not-found") {
        lastProperties = properties;
        recordCgroup(properties);
        const pid = finiteNumber(properties.ExecMainPID);
        if (pid !== undefined && pid > 0) {
          observedChildPid = pid;
        }
        const peak = finiteNumber(properties.MemoryPeak);
        if (peak !== undefined && (observedMemoryPeak === undefined || peak > observedMemoryPeak)) {
          observedMemoryPeak = peak;
        }
      }
    } catch {
      controlFailure = true;
    }
  };
  const trace = (
    phase: "started" | "completed",
    exitCode: number | null,
    cleanupVerified?: boolean,
  ) => {
    emitDiagnosticEvent({
      type: "exec.process.containment",
      phase,
      runId: input.runId,
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      unit,
      expectedCgroup,
      cgroup: observedCgroup,
      childPid: observedChildPid,
      startedAtMs,
      ...(phase === "completed" ? { endedAtMs: Date.now(), cleanupVerified } : {}),
      memoryPeakBytes: observedMemoryPeak,
      result: lastProperties.Result,
      exitCode,
    });
  };
  trace("started", null);
  const refuseStartup = async (message: string): Promise<never> => {
    child.kill("SIGKILL");
    await childExit.catch(() => undefined);
    let cleanupVerified = false;
    try {
      await stop();
      cleanupVerified = true;
    } finally {
      trace("completed", null, cleanupVerified);
      child.dispose();
    }
    throw new Error(message);
  };
  // Fast successful units can unload before inspection. Keep unknown PID/peak
  // absent; successful systemd-run --wait still proves the service terminated.
  while (true) {
    await observe();
    if (controlFailure) {
      return await refuseStartup("exec systemd-user service monitoring failed before activation");
    }
    const launcher = getLauncherState();
    if (launcher.status !== "running" || lastProperties.LoadState === "loaded") {
      break;
    }
    if (Date.now() >= startupDeadline) {
      return await refuseStartup("exec systemd-user service did not start before its deadline");
    }
    await delay(25);
  }
  let observing = false;
  const pollTimer = setInterval(() => {
    if (!finished && !observing) {
      observing = true;
      void observe()
        .then(async () => {
          if (controlFailure) {
            await stop();
          }
        })
        .catch(() => {
          controlFailure = true;
        })
        .finally(() => {
          observing = false;
        });
    }
  }, 250);
  pollTimer.unref?.();
  const wait = async () => {
    let exit: Awaited<ReturnType<typeof child.wait>>;
    try {
      exit = await childExit;
      await observe();
    } finally {
      finished = true;
      clearInterval(pollTimer);
      let cleanupVerified = false;
      try {
        await stop();
        cleanupVerified = true;
      } finally {
        const launcher = getLauncherState();
        const code = launcher.status === "exited" ? launcher.exit.code : null;
        trace("completed", code, cleanupVerified);
      }
    }
    const reset = await control(["reset-failed", unit]);
    if (!reset.ok && (await show(unit)).LoadState !== "not-found") {
      throw new Error("exec systemd-user service failed to release its terminal unit");
    }
    if (controlFailure) {
      throw new Error("exec systemd-user containment monitoring failed");
    }
    // systemd also reports stop-grace expiry as "timeout". The supervisor owns
    // the elapsed command budget; retain this result only in diagnostics.
    return exit;
  };
  return {
    // The launcher is not the service's main PID. Never present it as the child.
    stdin: child.stdin,
    onStdout: child.onStdout,
    onStderr: child.onStderr,
    wait,
    kill: (signal) => {
      if (signal === "SIGKILL") {
        void control(["kill", "--kill-whom=all", "--signal=SIGKILL", unit]);
      }
      void stop().catch(() => {
        controlFailure = true;
      });
    },
    dispose: () => {
      finished = true;
      clearInterval(pollTimer);
      child.dispose();
    },
  };
}
