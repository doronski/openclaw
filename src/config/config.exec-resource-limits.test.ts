import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("exec resourceLimits config", () => {
  it("accepts global and per-agent operator envelopes", () => {
    const limits = { backend: "systemd-user", slice: "commands.slice" };
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
