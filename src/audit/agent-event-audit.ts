/** Redaction-safe projection from live agent events into durable audit metadata. */
import { createHash } from "node:crypto";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  AGENT_RUN_TERMINAL_RETRY_GRACE_MS,
  buildAgentRunTerminalOutcome,
  mergeAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import { normalizeAgentRunTimeoutPhase } from "../agents/run-timeout-attribution.js";
import { isAllowedToolCallName } from "../agents/tool-call-shared.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import type { TrustedToolExecutionEvent } from "../infra/diagnostic-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type {
  AuditEventErrorCode,
  AuditEventInput,
  AuditEventStatus,
} from "./audit-event-types.js";
import { createAuditEventWriter, type AuditEventWriter } from "./audit-event-writer.js";

const runProvenance = new Map<
  string,
  { actorType: "agent" | "system"; agentId: string; sessionKey?: string; sessionId?: string }
>();
const MAX_TRACKED_RUN_PROVENANCE = 1_024;
const log = createSubsystemLogger("audit/events");
let persistenceFailureWarned = false;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function auditToolName(value: unknown): string | undefined {
  const toolName = nonEmptyString(value)?.trim();
  if (!toolName) {
    return undefined;
  }
  // Tool lifecycle producers include provider-controlled streams. Preserve
  // only the compact model-facing name contract at the durable boundary.
  return isAllowedToolCallName(toolName, null) ? toolName : "unknown";
}

function auditToolCallId(value: unknown): string | undefined {
  const toolCallId = nonEmptyString(value);
  if (!toolCallId) {
    return undefined;
  }
  // Call ids remain useful for correlation, but their provider-owned bytes
  // are not operator metadata and must never enter the ledger verbatim.
  return `sha256:${createHash("sha256").update(toolCallId).digest("hex")}`;
}

function rememberRunProvenance(
  runId: string,
  provenance: {
    actorType: "agent" | "system";
    agentId: string;
    sessionKey?: string;
    sessionId?: string;
  },
): void {
  runProvenance.delete(runId);
  runProvenance.set(runId, provenance);
  while (runProvenance.size > MAX_TRACKED_RUN_PROVENANCE) {
    const oldestRunId = runProvenance.keys().next().value;
    if (oldestRunId === undefined) {
      break;
    }
    runProvenance.delete(oldestRunId);
  }
}

function resolveProvenance(
  runId: string,
  event: { agentId?: unknown; sessionKey?: unknown; sessionId?: unknown },
) {
  const remembered = runProvenance.get(runId);
  const sessionKey = nonEmptyString(event.sessionKey) ?? remembered?.sessionKey;
  const sessionId = nonEmptyString(event.sessionId) ?? remembered?.sessionId;
  const eventAgentId = nonEmptyString(event.agentId);
  const sessionAgentId = sessionKey ? parseAgentSessionKey(sessionKey)?.agentId : undefined;
  const agentId = eventAgentId ?? sessionAgentId ?? remembered?.agentId ?? "unknown";
  const actorType = eventAgentId || sessionAgentId ? "agent" : (remembered?.actorType ?? "system");
  return { actorType, agentId, sessionKey, sessionId };
}

function resolveToolProvenance(
  runId: string,
  event: { agentId?: unknown; sessionKey?: unknown; sessionId?: unknown },
) {
  const observed = resolveProvenance(runId, event);
  const remembered = runProvenance.get(runId);
  if (!remembered) {
    return observed;
  }
  // Tool diagnostics may use an execution sandbox key. Lifecycle start owns
  // the canonical run identity; tool metadata only fills missing session fields.
  return {
    ...remembered,
    sessionKey: remembered.sessionKey ?? observed.sessionKey,
    sessionId: remembered.sessionId ?? observed.sessionId,
  };
}

function classifyRunTerminal(
  data: Record<string, unknown>,
  phase: "end" | "error",
): {
  outcome: AgentRunTerminalOutcome;
  status: AuditEventStatus;
  errorCode?: AuditEventErrorCode;
} {
  const stopReason = nonEmptyString(data.stopReason);
  const timeoutPhase = normalizeAgentRunTimeoutPhase(data.timeoutPhase);
  const terminalStatus = normalizeOptionalLowercaseString(data.status);
  const explicitlyTimedOut =
    stopReason === "timeout" ||
    timeoutPhase !== undefined ||
    terminalStatus === "timeout" ||
    terminalStatus === "timed_out";
  const explicitlyCancelled =
    !explicitlyTimedOut &&
    (data.aborted === true ||
      stopReason === "aborted" ||
      terminalStatus === "cancelled" ||
      terminalStatus === "canceled" ||
      terminalStatus === "aborted");
  // The terminal helper accepts wait statuses, so normalize explicit lifecycle
  // cancellation to its canonical stop signal without persisting the raw reason.
  const outcomeStopReason = explicitlyCancelled && !explicitlyTimedOut ? "stop" : stopReason;
  const outcome = buildAgentRunTerminalOutcome({
    status: explicitlyTimedOut
      ? "timeout"
      : phase === "error"
        ? "error"
        : explicitlyCancelled
          ? "error"
          : "ok",
    stopReason: outcomeStopReason,
    livenessState: data.livenessState,
    timeoutPhase,
    providerStarted: data.providerStarted,
    startedAt: data.startedAt,
    endedAt: data.endedAt,
  });
  if (outcome.reason === "cancelled" || outcome.reason === "aborted") {
    return { outcome, status: "cancelled", errorCode: "run_cancelled" };
  }
  if (outcome.reason === "hard_timeout" || outcome.reason === "timed_out") {
    return { outcome, status: "timed_out", errorCode: "run_timed_out" };
  }
  if (outcome.reason === "blocked") {
    return { outcome, status: "blocked", errorCode: "run_blocked" };
  }
  return outcome.reason === "completed"
    ? { outcome, status: "succeeded" }
    : { outcome, status: "failed", errorCode: "run_failed" };
}

type AgentAuditProjection = {
  input: AuditEventInput;
  terminal?: { outcome: AgentRunTerminalOutcome; phase: "end" | "error" };
};

function projectAgentEvent(event: AgentEventPayload): AgentAuditProjection | undefined {
  const runId = nonEmptyString(event.runId);
  const phase = nonEmptyString(event.data.phase);
  if (!runId || !phase) {
    return undefined;
  }
  const provenance = resolveProvenance(runId, event);
  if (event.stream === "lifecycle" && phase === "start") {
    rememberRunProvenance(runId, provenance);
    return {
      input: {
        sourceSequence: event.seq,
        occurredAt: asDateTimestampMs(event.data.startedAt) ?? event.ts,
        kind: "agent_run",
        action: "agent.run.started",
        status: "started",
        actorType: provenance.actorType,
        actorId: provenance.agentId,
        agentId: provenance.agentId,
        ...(provenance.sessionKey ? { sessionKey: provenance.sessionKey } : {}),
        ...(provenance.sessionId ? { sessionId: provenance.sessionId } : {}),
        runId,
      },
    };
  }
  if (event.stream === "lifecycle" && (phase === "end" || phase === "error")) {
    rememberRunProvenance(runId, provenance);
    const { outcome, ...terminal } = classifyRunTerminal(event.data, phase);
    return {
      input: {
        sourceSequence: event.seq,
        occurredAt: asDateTimestampMs(event.data.endedAt) ?? event.ts,
        kind: "agent_run",
        action: "agent.run.finished",
        ...terminal,
        actorType: provenance.actorType,
        actorId: provenance.agentId,
        agentId: provenance.agentId,
        ...(provenance.sessionKey ? { sessionKey: provenance.sessionKey } : {}),
        ...(provenance.sessionId ? { sessionId: provenance.sessionId } : {}),
        runId,
      },
      terminal: { outcome, phase },
    };
  }
  return undefined;
}

/** Return a metadata-only audit input for supported run lifecycle events. */
export function projectAgentEventToAudit(event: AgentEventPayload): AuditEventInput | undefined {
  return projectAgentEvent(event)?.input;
}

/** Project the complete trusted tool-execution lifecycle without private diagnostic content. */
export function projectToolExecutionEventToAudit(
  event: TrustedToolExecutionEvent,
): AuditEventInput | undefined {
  // Schema quarantine describes tool availability before invocation. Without
  // a call identity it must not become a durable tool-action claim.
  if (
    event.type === "tool.execution.blocked" &&
    event.deniedReason === "unsupported_tool_schema" &&
    !nonEmptyString(event.toolCallId)
  ) {
    return undefined;
  }
  const runId = nonEmptyString(event.runId);
  const toolName = auditToolName(event.toolName);
  if (!runId || !toolName) {
    return undefined;
  }
  const toolCallId = auditToolCallId(event.toolCallId);
  const provenance = resolveToolProvenance(runId, event);
  const errorCategory =
    event.type === "tool.execution.error"
      ? normalizeOptionalLowercaseString(event.errorCategory)
      : undefined;
  const terminalReason = event.type === "tool.execution.error" ? event.terminalReason : undefined;
  const diagnosticErrorCode =
    event.type === "tool.execution.error"
      ? normalizeOptionalLowercaseString(event.errorCode)
      : undefined;
  // Modern producers set terminalReason explicitly; errorCategory is only a
  // legacy fallback and must not override a definitive timeout or failure.
  const toolCancelled =
    terminalReason === "cancelled" ||
    (terminalReason === undefined &&
      (errorCategory === "aborted" ||
        errorCategory === "aborterror" ||
        errorCategory === "cancelled" ||
        errorCategory === "canceled"));
  const toolTimedOut = terminalReason === "timed_out";
  // Unknown is an explicit dependency boundary, not a failed-run inference.
  // Keep it authoritative when enclosing run provenance says cancel or timeout.
  const terminal =
    event.type === "tool.execution.started"
      ? { status: "started" as const }
      : event.type === "tool.execution.completed"
        ? { status: "succeeded" as const }
        : event.type === "tool.execution.blocked"
          ? { status: "blocked" as const, errorCode: "tool_blocked" as const }
          : diagnosticErrorCode === "tool_outcome_unknown"
            ? { status: "unknown" as const, errorCode: "tool_outcome_unknown" as const }
            : toolCancelled
              ? { status: "cancelled" as const, errorCode: "tool_cancelled" as const }
              : toolTimedOut
                ? { status: "timed_out" as const, errorCode: "tool_timed_out" as const }
                : { status: "failed" as const, errorCode: "tool_failed" as const };
  return {
    sourceSequence: event.seq,
    occurredAt: asDateTimestampMs(event.sourceTimestampMs) ?? event.ts,
    kind: "tool_action",
    action:
      event.type === "tool.execution.started" ? "tool.action.started" : "tool.action.finished",
    ...terminal,
    actorType: provenance.actorType,
    actorId: provenance.agentId,
    agentId: provenance.agentId,
    ...(provenance.sessionKey ? { sessionKey: provenance.sessionKey } : {}),
    ...(provenance.sessionId ? { sessionId: provenance.sessionId } : {}),
    runId,
    ...(toolCallId ? { toolCallId } : {}),
    toolName,
  };
}

/** Create the Gateway-owned non-blocking audit projection and persistence handle. */
export function createAgentEventAuditRecorder(options?: {
  writer?: AuditEventWriter;
  stateDir?: string;
  terminalSettleMs?: number;
}): {
  record: (event: AgentEventPayload) => void;
  recordTool: (event: TrustedToolExecutionEvent) => void;
  stop: () => Promise<void>;
} {
  const writer =
    options?.writer ??
    createAuditEventWriter({
      ...(options?.stateDir ? { stateDir: options.stateDir } : {}),
      onError: (error) => {
        if (!persistenceFailureWarned) {
          persistenceFailureWarned = true;
          log.warn(`audit event persistence failed: ${error}`);
        }
      },
    });
  type PendingTerminal = NonNullable<AgentAuditProjection["terminal"]> & {
    input: AuditEventInput;
    timer: ReturnType<typeof setTimeout>;
  };
  const terminalSettleMs = Math.max(
    0,
    Math.floor(options?.terminalSettleMs ?? AGENT_RUN_TERMINAL_RETRY_GRACE_MS),
  );
  const pendingTerminals = new Map<string, PendingTerminal>();
  const openRunInstances = new Set<string>();
  const settledRunInstances = new Set<string>();
  const execToolStarts = new Map<string, AuditEventInput | null>();
  const execOrigins = new Map<string, AuditEventInput>();

  const rememberBounded = <T>(map: Map<string, T>, key: string, value: T) => {
    map.set(key, value);
    if (map.size > MAX_TRACKED_RUN_PROVENANCE) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) {
        map.delete(oldest);
      }
    }
  };
  const recordExecProcess = (event: AgentEventPayload) => {
    const phase = event.data.phase;
    if (phase !== "started" && phase !== "completed") {
      return;
    }
    const toolCallId = auditToolCallId(event.data.toolCallId);
    const toolKey = `${event.sessionKey}\0${toolCallId}`;
    const origin =
      execOrigins.get(event.runId) ??
      (phase === "started" ? execToolStarts.get(toolKey) : undefined);
    if (!origin) {
      return;
    }
    const unit = nonEmptyString(event.data.unit);
    const expectedCgroup = nonEmptyString(event.data.expectedCgroup);
    const cgroup = nonEmptyString(event.data.cgroup);
    const startedAt = asDateTimestampMs(event.data.startedAtMs);
    const endedAt = asDateTimestampMs(event.data.endedAtMs);
    if (
      !unit ||
      !expectedCgroup ||
      startedAt === undefined ||
      (phase === "completed" && endedAt === undefined)
    ) {
      return;
    }
    const pid = event.data.childPid;
    const input: AuditEventInput = {
      ...origin,
      execProcess: {
        ...origin.execProcess,
        runId: event.runId,
        unit,
        expectedCgroup,
        ...(cgroup ? { cgroup } : {}),
        ...(typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
        startedAt,
        ...(phase === "completed"
          ? {
              endedAt,
              exitCode: typeof event.data.exitCode === "number" ? event.data.exitCode : null,
              cleanupVerified: event.data.cleanupVerified === true,
            }
          : {}),
      },
    };
    if (phase === "started") {
      rememberBounded(execOrigins, event.runId, input);
    } else {
      execOrigins.delete(event.runId);
    }
    writer.record(input);
  };

  const rememberSettled = (runInstance: string) => {
    settledRunInstances.delete(runInstance);
    settledRunInstances.add(runInstance);
    if (settledRunInstances.size > MAX_TRACKED_RUN_PROVENANCE) {
      const oldest = settledRunInstances.values().next().value;
      if (oldest !== undefined) {
        settledRunInstances.delete(oldest);
      }
    }
  };
  const clearPending = (runInstance: string) => {
    const pending = pendingTerminals.get(runInstance);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    pendingTerminals.delete(runInstance);
  };
  const flushPending = (runInstance: string) => {
    const pending = pendingTerminals.get(runInstance);
    if (!pending) {
      return;
    }
    clearPending(runInstance);
    openRunInstances.delete(runInstance);
    if (writer.record(pending.input)) {
      rememberSettled(runInstance);
    }
  };
  const scheduleTerminal = (runInstance: string, incoming: Omit<PendingTerminal, "timer">) => {
    const existing = pendingTerminals.get(runInstance);
    let selected = incoming;
    if (existing) {
      // A bare cleanup end can follow a definitive error without a retry start.
      // Otherwise use the shared sticky timeout/cancellation merge contract.
      const cleanupAfterError =
        existing.phase === "error" &&
        incoming.phase === "end" &&
        incoming.outcome.reason === "completed";
      if (cleanupAfterError) {
        selected = existing;
      } else {
        const merged = mergeAgentRunTerminalOutcome(existing.outcome, incoming.outcome);
        selected = merged === existing.outcome ? existing : incoming;
      }
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => flushPending(runInstance), terminalSettleMs);
    timer.unref?.();
    pendingTerminals.delete(runInstance);
    pendingTerminals.set(runInstance, { ...selected, timer });
    if (pendingTerminals.size > MAX_TRACKED_RUN_PROVENANCE) {
      const oldest = pendingTerminals.keys().next().value;
      if (oldest !== undefined) {
        flushPending(oldest);
      }
    }
  };

  return {
    record: (event) => {
      // Only the core adapter's private audit bus reaches this projection.
      // Public/plugin diagnostic events cannot mint execution-to-tool bindings.
      if (event.stream === "exec.process.containment") {
        recordExecProcess(event);
        return;
      }
      const projection = projectAgentEvent(event);
      if (!projection) {
        return;
      }
      const runInstance = `${event.lifecycleGeneration ?? "unknown"}\0${event.runId}`;
      if (!projection.terminal) {
        const alreadyOpen = openRunInstances.has(runInstance);
        clearPending(runInstance);
        settledRunInstances.delete(runInstance);
        if (alreadyOpen) {
          return;
        }
        // Retry starts cancel a provisional terminal for the same logical run.
        // Keep the original start so one run cannot acquire unmatched starts.
        openRunInstances.add(runInstance);
        writer.record(projection.input);
        return;
      }
      if (settledRunInstances.has(runInstance)) {
        return;
      }
      if (
        projection.terminal.outcome.reason === "completed" &&
        !pendingTerminals.has(runInstance)
      ) {
        openRunInstances.delete(runInstance);
        if (writer.record(projection.input)) {
          rememberSettled(runInstance);
        }
        return;
      }
      scheduleTerminal(runInstance, { input: projection.input, ...projection.terminal });
    },
    recordTool: (event) => {
      const input = projectToolExecutionEventToAudit(event);
      if (input) {
        if (
          event.type === "tool.execution.started" &&
          input.toolName === "exec" &&
          input.sessionKey &&
          input.toolCallId
        ) {
          const key = `${input.sessionKey}\0${input.toolCallId}`;
          // Reused provider call IDs across runs are ambiguous. Never let a later
          // start relabel a deferred command from the earlier run.
          const previous = execToolStarts.get(key);
          const sameOrigin =
            previous?.runId === input.runId && previous.sessionId === input.sessionId;
          rememberBounded(execToolStarts, key, previous === undefined || sameOrigin ? input : null);
        }
        writer.record(input);
      }
    },
    stop: async () => {
      execToolStarts.clear();
      execOrigins.clear();
      for (const runInstance of pendingTerminals.keys()) {
        flushPending(runInstance);
      }
      await writer.stop();
    },
  };
}

export function resetAgentEventAuditForTest(): void {
  runProvenance.clear();
  persistenceFailureWarned = false;
}
