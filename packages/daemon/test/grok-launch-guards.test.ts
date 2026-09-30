import { describe, expect, it, vi } from "vitest";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import { GrokRuntimeAdapter, grokSeatPaths, type GrokAdapterFsOps } from "../src/adapters/grok-runtime-adapter.js";

const STATE = "/state/grok";
const HOME = "/home/test/.grok";
const SESSION = "dev-grok";
const SID = "0b7c6a52-3f1e-4d2a-9c8b-1a2b3c4d5e6f";
type MemFs = GrokAdapterFsOps & { files: Record<string, string> };

function memFs(initial: Record<string, string> = {}): MemFs {
  const files = { ...initial };
  const dirs = new Set<string>();
  return {
    files,
    readFile: (p) => { if (p in files) return files[p]!; throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    writeFile: (p, c) => { files[p] = c; },
    exists: (p) => p in files || dirs.has(p) || Object.keys(files).some((f) => f.startsWith(`${p}/`)),
    mkdirp: (p) => { dirs.add(p); },
    listFiles: (p) => Object.keys(files).filter((f) => f.startsWith(`${p}/`)).map((f) => f.slice(p.length + 1)),
  };
}

function tmux(fs: MemFs) {
  return {
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => {
      fs.files[`${HOME}/active_sessions.json`] = JSON.stringify([{ session_id: SID, pid: 1, opened_at: new Date().toISOString() }]);
      return { ok: true as const };
    }),
    capturePaneContent: vi.fn(async () => ""),
  };
}

const binding = (): NodeBinding => ({ id: "b", nodeId: "n", tmuxSession: SESSION, tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, cwd: "/work", updatedAt: "", launchPosture: "floor" } as NodeBinding);

function adapter(fs: MemFs, t: ReturnType<typeof tmux>, grokHome = HOME) {
  return new GrokRuntimeAdapter({ tmux: t as unknown as TmuxAdapter, fsOps: fs, stateRoot: STATE, grokHome, newSessionId: () => SID, sleep: async () => {}, isPidAlive: () => true });
}

describe("grok launch guards", () => {
  it("refuses relative GROK_HOME before writing state, while an absolute home launches", async () => {
    const fs = memFs(); const t = tmux(fs);
    const refused = await adapter(fs, t, "relative/home").launchHarness(binding(), { name: "seat" });
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/GROK_HOME.*relative\/home/) });
    expect(t.sendText).not.toHaveBeenCalled();
    expect(Object.keys(fs.files)).toEqual([]);
    expect((await adapter(fs, t).launchHarness(binding(), { name: "seat" })).ok).toBe(true);
  });

  it("refuses unsafe and oversized prompts before writing state", async () => {
    for (const prompt of ["-option", "é".repeat(50_000)]) {
      const fs = memFs(); const t = tmux(fs);
      const result = await adapter(fs, t).launchHarness(binding(), { name: "seat", initialPrompt: prompt });
      expect(result.ok).toBe(false);
      if (!result.ok && prompt.startsWith("é")) expect(result.error).toContain("100000 bytes");
      expect(t.sendText).not.toHaveBeenCalled();
      expect(Object.keys(fs.files)).toEqual([]);
    }
  });

  it("empties a stale prompt when no prompt is supplied", async () => {
    const paths = grokSeatPaths(STATE, SESSION);
    const fs = memFs({ [`${paths.seatDir}/initial-prompt.md`]: "STALE" }); const t = tmux(fs);
    expect((await adapter(fs, t).launchHarness(binding(), { name: "seat" })).ok).toBe(true);
    expect(fs.files[`${paths.seatDir}/initial-prompt.md`]).toBe("");
    expect(t.sendText.mock.calls[0]?.[1]).not.toContain("'P'");
  });

  it("adds and removes the managed seat-skills pointer", async () => {
    const paths = grokSeatPaths(STATE, SESSION);
    const skill = `${paths.skillsDir}/helper/SKILL.md`;
    const fs = memFs({ [skill]: "# helper" }); const t = tmux(fs);
    expect((await adapter(fs, t).launchHarness(binding(), { name: "seat" })).ok).toBe(true);
    expect(fs.files[paths.standingInstructions]).toContain(paths.skillsDir);
    delete fs.files[skill];
    expect((await adapter(fs, t).launchHarness(binding(), { name: "seat" })).ok).toBe(true);
    expect(fs.files[paths.standingInstructions] ?? "").not.toContain("openrig-grok-skills");
  });
});
