import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("exec resourceLimits config", () => {
  it("accepts global and per-agent operator envelopes", () => {
    const limits = {
      backend: "systemd-user",
      slice: "commands.slice",
      hostMemoryAdmission: { minAvailableBytes: 2_147_483_648, maxFullPressureAvg10: 0.5 },
    };
    const result = validateConfigObject({
      tools: { exec: { resourceLimits: limits } },
      agents: {
        list: [
          {
            id: "large-jobs",
            tools: {
              exec: {
                resourceLimits: { ...limits, memoryMaxBytes: 8_589_934_592, timeoutSec: 300 },
              },
            },
          },
        ],
      },
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    {},
    { minAvailableBytes: 0, maxFullPressureAvg10: 1 },
    { minAvailableBytes: 0.5, maxFullPressureAvg10: 1 },
    { minAvailableBytes: Number.MAX_SAFE_INTEGER + 1, maxFullPressureAvg10: 1 },
    { minAvailableBytes: 1, maxFullPressureAvg10: -1 },
    { minAvailableBytes: 1, maxFullPressureAvg10: 101 },
    { minAvailableBytes: 1, maxFullPressureAvg10: Infinity },
    { minAvailableBytes: 1, maxFullPressureAvg10: NaN },
    { minAvailableBytes: 1, maxFullPressureAvg10: 1, fallback: true },
  ])("rejects invalid host admission globally and per-agent: %j", (hostMemoryAdmission) => {
    const resourceLimits = { backend: "systemd-user", slice: "commands.slice", hostMemoryAdmission };
    expect(validateConfigObject({ tools: { exec: { resourceLimits } } }).ok).toBe(false);
    expect(validateConfigObject({
      agents: { list: [{ id: "contained", tools: { exec: { resourceLimits } } }] },
    }).ok).toBe(false);
  });

  it.each([
    { backend: "other", slice: "commands.slice" },
    { backend: "systemd-user", slice: "../commands.slice" },
    { backend: "systemd-user", slice: "commands.slice", memoryMaxBytes: 1 },
    { backend: "systemd-user", slice: "commands.slice", memorySwapMaxBytes: -1 },
    { backend: "systemd-user", slice: "commands.slice", timeoutSec: 0 },
    { backend: "systemd-user", slice: "commands.slice", tasksMax: 1.5 },
    { backend: "systemd-user", slice: "commands.slice", fallback: true },
  ])("rejects unsupported or unsafe policy %j", (resourceLimits) => {
    expect(validateConfigObject({ tools: { exec: { resourceLimits } } }).ok).toBe(false);
  });
});
