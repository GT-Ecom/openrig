import { describe, expect, it, vi } from "vitest";
import { diagnoseRuntimePosture, observeCodexSandbox, type AppliedLaunchObservation, type PermissionDriftFs } from "../src/domain/permission-drift.js";

function fixture(commandAvailable = true): PermissionDriftFs {
  return {
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    cwdReadable: () => true,
    commandAvailable: vi.fn(() => commandAvailable),
    claudePermissionModes: () => null,
  };
}

describe("grok permission drift", () => {
  it("reports an observed bypass on the permission axis", () => {
    const applied: AppliedLaunchObservation = { runtime: "grok", axis: "permission", state: "observed", value: "bypassPermissions" };
    expect(diagnoseRuntimePosture({ runtime: "grok", cwd: "/work", applied, fs: fixture() }).enforcement).toMatchObject({
      axis: "permission", state: "aligned", expected: "bypassPermissions",
    });
  });

  it("preserves the adapter's unknown floor reason", () => {
    const applied: AppliedLaunchObservation = { runtime: "grok", axis: "permission", state: "unknown", value: null, reason: "unverified_mode_mapping" };
    expect(diagnoseRuntimePosture({ runtime: "grok", cwd: "/work", applied, fs: fixture() }).enforcement).toMatchObject({
      axis: "permission", state: "unknown", reason: "unverified_mode_mapping",
    });
  });

  it.each([[true, "available"], [false, "missing"]] as const)("checks the grok command path", (available, state) => {
    const fs = fixture(available);
    expect(diagnoseRuntimePosture({ runtime: "grok", cwd: "/work", applied: null, fs }).commandPath.state).toBe(state);
    expect(fs.commandAvailable).toHaveBeenCalledWith("grok");
  });

  it("keeps Codex on the sandbox axis", () => {
    expect(diagnoseRuntimePosture({ runtime: "codex", cwd: "/work", applied: observeCodexSandbox("-s workspace-write"), fs: fixture() }).enforcement).toMatchObject({ axis: "sandbox", state: "aligned" });
  });
});
