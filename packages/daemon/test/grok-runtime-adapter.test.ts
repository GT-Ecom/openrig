// Hermetic tests for the grok runtime adapter: fake tmux, in-memory fs, injected clock, ids and
// kill function. No grok binary runs; one checkReady case runs the installed hook through `sh`
// against a temp dir to prove a subagent's events never reach the seat.

import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { spawnSync } from "node:child_process";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import { GrokRuntimeAdapter, type GrokAdapterFsOps, type GrokRuntimeAdapterDeps } from "../src/adapters/grok-runtime-adapter.js";
import { PiRuntimeAdapter } from "../src/adapters/pi-runtime-adapter.js";
import { buildWrappedLaunch } from "../src/adapters/launch-wrapper.js";
import { grokEventsPath, grokHookFileName, grokMarkerPath } from "../src/adapters/grok-hooks.js";

const STATE = "/openrig-home/state/grok";
const GROK_HOME = "/home/op/.grok";
const SESSION = "dev-grok@some-rig";
const SEAT = `${STATE}/seats/${SESSION}`;
const RULES = `${SEAT}/standing-instructions.md`;
const SID = "0b7c6a52-3f1e-4d2a-9c8b-1a2b3c4d5e6f";
const TOKEN = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";
const PARENT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER = "9f9f9f9f-0000-4000-8000-000000000001";
const NOW = Date.parse("2026-09-29T12:00:00Z");

type MemFs = GrokAdapterFsOps & { files: Record<string, string> };

function memFs(initial: Record<string, string> = {}): MemFs {
  const files: Record<string, string> = { ...initial };
  const dirs = new Set<string>();
  return {
    files,
    readFile: (p) => { if (p in files) return files[p]!; throw new Error(`ENOENT: ${p}`); },
    writeFile: (p, c) => { files[p] = c; },
    exists: (p) => p in files || dirs.has(p) || Object.keys(files).some((k) => k.startsWith(p + "/")),
    mkdirp: (p) => { dirs.add(p); },
    listFiles: (d) => Object.keys(files).filter((k) => k.startsWith(d + "/")).map((k) => k.slice(d.length + 1)),
  };
}

function fakeTmux(opts: { onEnter?: () => void; paneCommand?: () => string | null } = {}) {
  return {
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async (_t: string, keys: string[]) => {
      if (keys.includes("Enter")) opts.onEnter?.();
      return { ok: true as const };
    }),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => (opts.paneCommand ? opts.paneCommand() : "grok")),
    capturePaneContent: vi.fn(async () => "line 1\nline 2\ngrok: waiting for login"),
  };
}

function binding(extra: Partial<NodeBinding> = {}): NodeBinding {
  return {
    id: "b1", nodeId: "n1", tmuxSession: SESSION, tmuxWindow: null, tmuxPane: null,
    cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/work/project", launchPosture: "floor",
    ...extra,
  } as NodeBinding;
}

function adapter(fsOps: GrokAdapterFsOps, tmux: ReturnType<typeof fakeTmux>, extra: Partial<GrokRuntimeAdapterDeps> = {}) {
  return new GrokRuntimeAdapter({
    tmux: tmux as unknown as TmuxAdapter,
    fsOps,
    stateRoot: STATE,
    grokHome: GROK_HOME,
    sleep: async () => {},
    newSessionId: () => SID,
    now: () => NOW,
    kill: () => true,
    ...extra,
  });
}

const eventLine = (event: string, id: string) =>
  JSON.stringify({ event, sessionId: id, at_s: Math.floor(NOW / 1000), permissionMode: "" }) + "\n";

function appendEvent(fsOps: MemFs, event: string, id: string, fileId = id): void {
  const p = grokEventsPath(STATE, fileId);
  fsOps.files[p] = (fsOps.files[p] ?? "") + eventLine(event, id);
}

function writeActive(fsOps: MemFs, id: string, pid: number, openedAtMs: number): void {
  fsOps.files[`${GROK_HOME}/active_sessions.json`] = JSON.stringify([
    { session_id: id, pid, cwd: "/work/project", opened_at: new Date(openedAtMs).toISOString() },
  ]);
}

const typedLines = (tmux: ReturnType<typeof fakeTmux>) => tmux.sendText.mock.calls.map((c) => (c as unknown[])[1] as string);

const errno = (code: string) => Object.assign(new Error(code), { code });

const FLOOR = ["--permission-mode", "acceptEdits"];

describe("GrokRuntimeAdapter.deliverStartup", () => {
  const files: ResolvedStartupFile[] = [
    { path: "rig-role", absolutePath: "/spec/rig-role", ownerRoot: "/spec", deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] },
    { path: "startup/brief.txt", absolutePath: "/spec/startup/brief.txt", ownerRoot: "/spec", deliveryHint: "auto", required: true, appliesOn: ["fresh_start"] },
    { path: "guidance.md", absolutePath: "/spec/guidance.md", ownerRoot: "/spec", deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start"] },
    { path: "skills/helper/SKILL.md", absolutePath: "/spec/skills/helper/SKILL.md", ownerRoot: "/spec", deliveryHint: "skill_install", required: true, appliesOn: ["fresh_start"] },
  ];
  const sources = {
    "/spec/rig-role": "You are the grok seat ROLE-TEXT.",
    "/spec/startup/brief.txt": "BRIEF-TEXT: start here",
    "/spec/guidance.md": "GUIDANCE-TEXT",
    "/spec/skills/helper/SKILL.md": "# SKILL helper",
  };

  it("never pastes a brief: send_text content (rig-role included) goes into the standing-instructions file", async () => {
    const fsOps = memFs(sources);
    const tmux = fakeTmux();
    const result = await adapter(fsOps, tmux).deliverStartup(files, binding());
    expect(result).toEqual({ delivered: 4, failed: [] });
    expect(tmux.sendText).toHaveBeenCalledTimes(0);
    const rules = fsOps.files[RULES]!;
    expect(rules).toContain("You are the grok seat ROLE-TEXT.");
    expect(rules).toContain("BRIEF-TEXT: start here");
    expect(rules).toContain("GUIDANCE-TEXT");
    expect(fsOps.files[`${SEAT}/skills/helper/SKILL.md`]).toBe("# SKILL helper");
    expect(Object.keys(fsOps.files).some((k) => k.startsWith("/work/project"))).toBe(false);
    const installed = await adapter(fsOps, tmux).listInstalled(binding());
    expect(installed.map((r) => r.effectiveId)).toEqual(["helper/SKILL.md"]);

    // Redelivery replaces the managed blocks instead of duplicating them.
    await adapter(fsOps, tmux).deliverStartup(files, binding());
    expect(fsOps.files[RULES]!.split("BRIEF-TEXT").length - 1).toBe(1);
  });

  it("control: the Pi adapter given the same send_text file DOES paste it", async () => {
    const fsOps = memFs(sources);
    const tmux = fakeTmux();
    const pi = new PiRuntimeAdapter({ tmux: tmux as unknown as TmuxAdapter, fsOps, stateRoot: "/state/pi", runnerEntryPath: "/r.js", sleep: async () => {} });
    await pi.deliverStartup([files[1]!], binding());
    expect(typedLines(tmux)).toContain("BRIEF-TEXT: start here");
  });
});

describe("GrokRuntimeAdapter.launchHarness argv", () => {
  const expectLine = (argv: string[], extra: { before?: string[][]; env?: Record<string, string>; rules?: boolean } = {}) =>
    buildWrappedLaunch({
      argv,
      env: { GROK_HOME: GROK_HOME, ...(extra.env ?? {}) },
      ...(extra.before ? { before: extra.before } : {}),
      ...(extra.rules === false ? {} : { argFiles: [{ flag: "--rules", path: RULES }] }),
    });

  it("fresh: grok --session-id <new uuid> with the floor posture, the model, GROK_HOME and --rules", async () => {
    const fsOps = memFs({ [RULES]: "rules" });
    const tmux = fakeTmux({ onEnter: () => appendEvent(fsOps, "session_start", SID) });
    const r = await adapter(fsOps, tmux).launchHarness(binding({ model: "grok-4" }), { name: "seat" });
    expect(r).toMatchObject({ ok: true, resumeToken: SID, resumeType: "grok_id" });
    expect(typedLines(tmux)).toEqual([expectLine(["grok", "--session-id", SID, ...FLOOR, "-m", "grok-4"])]);
    expect(tmux.sendKeys).toHaveBeenCalledWith(SESSION, ["Enter"]);
    expect(typedLines(tmux)[0]).not.toContain("bypassPermissions");
  });

  it("resume: grok --resume <token>, never -c", async () => {
    const fsOps = memFs({ [RULES]: "rules" });
    const tmux = fakeTmux({ onEnter: () => appendEvent(fsOps, "session_start", TOKEN) });
    const r = await adapter(fsOps, tmux).launchHarness(binding(), { name: "seat", resumeToken: TOKEN });
    expect(r).toMatchObject({ ok: true, resumeToken: TOKEN, resumeType: "grok_id" });
    expect(typedLines(tmux)).toEqual([expectLine(["grok", "--resume", TOKEN, ...FLOOR])]);
    expect(typedLines(tmux)[0]).not.toMatch(/'-c'|'--continue'/);
  });

  it("fork: grok --resume <parent> --fork-session --session-id <new uuid>", async () => {
    const fsOps = memFs({ [RULES]: "rules" });
    const tmux = fakeTmux({ onEnter: () => appendEvent(fsOps, "session_start", SID) });
    const r = await adapter(fsOps, tmux).launchHarness(binding(), { name: "seat", forkSource: { kind: "native_id", value: PARENT } });
    expect(r).toMatchObject({ ok: true, resumeToken: SID, resumeType: "grok_id" });
    expect(typedLines(tmux)).toEqual([expectLine(["grok", "--resume", PARENT, "--fork-session", "--session-id", SID, ...FLOOR])]);
  });

  it("full_bypass carries --permission-mode bypassPermissions; auth adds the provider env and a login step", async () => {
    const fsOps = memFs();
    const tmux = fakeTmux({ onEnter: () => appendEvent(fsOps, "session_start", SID) });
    const r = await adapter(fsOps, tmux, { authProviderCommand: "print-token --x" }).launchHarness(binding({ launchPosture: "full_bypass" }), { name: "seat" });
    expect(r.ok).toBe(true);
    expect(typedLines(tmux)).toEqual([
      expectLine(["grok", "--session-id", SID, "--permission-mode", "bypassPermissions"], {
        env: { GROK_AUTH_PROVIDER_COMMAND: "print-token --x" },
        before: [["grok", "login"]],
        rules: false,
      }),
    ]);
  });

  it("installs the hook and the marker, and persists the launch baseline in session.json", async () => {
    const fsOps = memFs();
    appendEvent(fsOps, "session_start", TOKEN);
    appendEvent(fsOps, "session_end", TOKEN);
    const baseline = Buffer.byteLength(fsOps.files[grokEventsPath(STATE, TOKEN)]!);
    const tmux = fakeTmux({ onEnter: () => appendEvent(fsOps, "session_start", TOKEN) });
    await adapter(fsOps, tmux).launchHarness(binding(), { name: "seat", resumeToken: TOKEN });
    expect(fsOps.files[`${GROK_HOME}/hooks/${grokHookFileName(STATE)}`]).toContain("openrig-hook");
    expect(grokMarkerPath(STATE, TOKEN) in fsOps.files).toBe(true);
    expect(JSON.parse(fsOps.files[`${SEAT}/session.json`]!)).toMatchObject({ sessionId: TOKEN, eventsBaselineBytes: baseline, launchedAtMs: NOW });
  });
});

describe("GrokRuntimeAdapter.launchHarness refusals before typing", () => {
  it("refuses resumeToken plus forkSource", async () => {
    const tmux = fakeTmux();
    const r = await adapter(memFs(), tmux).launchHarness(binding(), { name: "s", resumeToken: TOKEN, forkSource: { kind: "native_id", value: PARENT } });
    expect(r).toMatchObject({ ok: false, error: "resumeToken and forkSource are mutually exclusive — pick one" });
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  it("refuses a malformed resume token without echoing it", async () => {
    for (const bad of ["not-a-uuid", "../../etc/passwd", "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a;x"]) {
      const tmux = fakeTmux();
      const r = await adapter(memFs(), tmux).launchHarness(binding(), { name: "s", resumeToken: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).not.toContain(bad);
      expect(tmux.sendText).not.toHaveBeenCalled();
    }
  });

  it("refuses standing instructions over 98,304 BYTES even when string.length is under the limit", async () => {
    const text = "é".repeat(60000);
    expect(text.length).toBeLessThan(98304);
    const bytes = Buffer.byteLength(text, "utf8");
    expect(bytes).toBeGreaterThan(98304);
    const tmux = fakeTmux();
    const r = await adapter(memFs({ [RULES]: text }), tmux).launchHarness(binding(), { name: "s" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain(RULES);
      expect(r.error).toContain(`${bytes} bytes`);
    }
    expect(tmux.sendText).not.toHaveBeenCalled();
  });
});

describe("GrokRuntimeAdapter.launchHarness readiness", () => {
  it("ready via the hook events alone", async () => {
    const fsOps = memFs();
    const tmux = fakeTmux({ onEnter: () => appendEvent(fsOps, "session_start", SID) });
    const r = await adapter(fsOps, tmux, { kill: () => { throw errno("ESRCH"); } }).launchHarness(binding(), { name: "s" });
    expect(r).toMatchObject({ ok: true, resumeToken: SID, resumeType: "grok_id" });
  });

  it("ready via active_sessions.json alone (live pid)", async () => {
    const fsOps = memFs();
    const tmux = fakeTmux({ onEnter: () => writeActive(fsOps, SID, 4242, NOW + 500) });
    const r = await adapter(fsOps, tmux, { kill: () => true }).launchHarness(binding(), { name: "s" });
    expect(r).toMatchObject({ ok: true, resumeToken: SID, resumeType: "grok_id" });
  });

  it("an EPERM pid counts as alive", async () => {
    const fsOps = memFs();
    const tmux = fakeTmux({ onEnter: () => writeActive(fsOps, SID, 4242, NOW + 500) });
    const r = await adapter(fsOps, tmux, { kill: () => { throw errno("EPERM"); } }).launchHarness(binding(), { name: "s" });
    expect(r.ok).toBe(true);
  });

  it("attention_required with pane evidence when neither signal appears", async () => {
    const tmux = fakeTmux();
    const r = await adapter(memFs(), tmux).launchHarness(binding(), { name: "s" });
    expect(r).toMatchObject({ ok: false, recovery: "attention_required" });
    if (!r.ok) expect(r.evidence).toContain("grok: waiting for login");
  });

  it("attention_required when the only entry has a dead pid (ESRCH)", async () => {
    const fsOps = memFs();
    const tmux = fakeTmux({ onEnter: () => writeActive(fsOps, SID, 4242, NOW + 500) });
    const r = await adapter(fsOps, tmux, { kill: () => { throw errno("ESRCH"); } }).launchHarness(binding(), { name: "s" });
    expect(r).toMatchObject({ ok: false, recovery: "attention_required" });
  });

  it("stale events on resume neither block readiness nor make it ready early", async () => {
    const seed = () => {
      const fsOps = memFs();
      appendEvent(fsOps, "session_start", TOKEN);
      appendEvent(fsOps, "session_end", TOKEN);
      return fsOps;
    };
    // Old start+end only: not ready early.
    const early = seed();
    const r1 = await adapter(early, fakeTmux()).launchHarness(binding(), { name: "s", resumeToken: TOKEN });
    expect(r1).toMatchObject({ ok: false, recovery: "attention_required" });
    // A live, fresh active_sessions entry: ready, and the old session_end does not block it.
    const fsOps = seed();
    const tmux = fakeTmux({ onEnter: () => writeActive(fsOps, TOKEN, 4242, NOW + 500) });
    const a = adapter(fsOps, tmux);
    const r2 = await a.launchHarness(binding(), { name: "s", resumeToken: TOKEN });
    expect(r2).toMatchObject({ ok: true, resumeToken: TOKEN, resumeType: "grok_id" });
    expect(await a.checkReady(binding())).toEqual({ ready: true });
  });

  it("pid reuse: an entry opened more than 5 s before the launch is not ready; after the launch it is", async () => {
    const stale = memFs();
    const r1 = await adapter(stale, fakeTmux({ onEnter: () => writeActive(stale, TOKEN, 4242, NOW - 6000) })).launchHarness(binding(), { name: "s", resumeToken: TOKEN });
    expect(r1).toMatchObject({ ok: false, recovery: "attention_required" });
    const fresh = memFs();
    const r2 = await adapter(fresh, fakeTmux({ onEnter: () => writeActive(fresh, TOKEN, 4242, NOW + 1000) })).launchHarness(binding(), { name: "s", resumeToken: TOKEN });
    expect(r2.ok).toBe(true);
  });

  it("an entry with an unparseable opened_at does not count", async () => {
    const fsOps = memFs();
    const tmux = fakeTmux({
      onEnter: () => { fsOps.files[`${GROK_HOME}/active_sessions.json`] = JSON.stringify([{ session_id: SID, pid: 7, cwd: "/", opened_at: "soon" }]); },
    });
    const r = await adapter(fsOps, tmux).launchHarness(binding(), { name: "s" });
    expect(r).toMatchObject({ ok: false, recovery: "attention_required" });
  });

  it("posture observation: floor is unknown (unverified_mode_mapping); full bypass is observed", async () => {
    const floorFs = memFs();
    const floor = await adapter(floorFs, fakeTmux({ onEnter: () => appendEvent(floorFs, "session_start", SID) })).launchHarness(binding({ launchPosture: "floor" }), { name: "s" });
    expect(floor.ok && floor.appliedLaunch).toEqual({ runtime: "grok", axis: "permission", state: "unknown", value: null, reason: "unverified_mode_mapping" });
    const bypassFs = memFs();
    const bypass = await adapter(bypassFs, fakeTmux({ onEnter: () => appendEvent(bypassFs, "session_start", SID) })).launchHarness(binding({ launchPosture: "full_bypass" }), { name: "s" });
    expect(bypass.ok && bypass.appliedLaunch).toEqual({ runtime: "grok", axis: "permission", state: "observed", value: "bypassPermissions" });
  });
});

describe("GrokRuntimeAdapter.checkReady", () => {
  async function launched(paneCommand: () => string | null = () => "grok") {
    const fsOps = memFs();
    const tmux = fakeTmux({ onEnter: () => appendEvent(fsOps, "session_start", SID), paneCommand });
    const a = adapter(fsOps, tmux);
    const r = await a.launchHarness(binding(), { name: "s" });
    expect(r.ok).toBe(true);
    return { fsOps, tmux, a };
  }

  it("ready after launch, and again from session.json after a daemon restart", async () => {
    const { fsOps, tmux, a } = await launched();
    expect(await a.checkReady(binding())).toEqual({ ready: true });
    expect(await adapter(fsOps, tmux).checkReady(binding())).toEqual({ ready: true });
  });

  it("no tmux session, or the session is gone → not ready", async () => {
    const { a, tmux } = await launched();
    expect((await a.checkReady(binding({ tmuxSession: null }))).ready).toBe(false);
    tmux.hasSession.mockImplementation(async () => false);
    expect((await a.checkReady(binding())).ready).toBe(false);
  });

  it("a stale session_start with the pane at zsh → runner_exited", async () => {
    let pane = "grok";
    const { a } = await launched(() => pane);
    pane = "zsh";
    expect(await a.checkReady(binding())).toMatchObject({ ready: false, code: "runner_exited" });
  });

  it("session_end after the start → runner_exited", async () => {
    const { a, fsOps } = await launched();
    appendEvent(fsOps, "session_end", SID);
    expect(await a.checkReady(binding())).toMatchObject({ ready: false, code: "runner_exited" });
  });

  it("an event for a DIFFERENT session id does not make the seat ready", async () => {
    const fsOps = memFs();
    const tmux = fakeTmux({
      onEnter: () => {
        appendEvent(fsOps, "session_start", OTHER);
        appendEvent(fsOps, "session_start", OTHER, SID); // a foreign line inside the seat's own file
        writeActive(fsOps, OTHER, 4242, NOW + 500);
      },
    });
    const a = adapter(fsOps, tmux);
    const r = await a.launchHarness(binding(), { name: "s" });
    expect(r).toMatchObject({ ok: false, recovery: "attention_required" });
    expect(await a.checkReady(binding())).toMatchObject({ ready: false, code: "awaiting_runtime" });
  });

  describe("with the real hook under sh", () => {
    let dir: string | undefined;
    afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });

    it("a subagent's events never reach the file; the TUI's own session_start does", async () => {
      dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-grok-adapter-"));
      const stateRoot = nodePath.join(dir, "state");
      const grokHome = nodePath.join(dir, "grok");
      const realFs: GrokAdapterFsOps = {
        readFile: (p) => fs.readFileSync(p, "utf8"),
        writeFile: (p, c) => fs.writeFileSync(p, c),
        exists: (p) => fs.existsSync(p),
        mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
        fileSize: (p) => fs.statSync(p).size,
      };
      const fire = (envelope: Record<string, unknown>) => {
        const hookFile = JSON.parse(fs.readFileSync(nodePath.join(grokHome, "hooks", grokHookFileName(stateRoot)), "utf8"));
        const r = spawnSync("/bin/sh", ["-c", hookFile.hooks.SessionStart[0].hooks[0].command], {
          env: { PATH: "/usr/bin:/bin", GROK_HOOK_EVENT: "session_start", GROK_SESSION_ID: SID },
          input: JSON.stringify({ sessionId: SID, cwd: "/w", hookEventName: "SessionStart", ...envelope }),
          encoding: "utf8",
        });
        expect(r.status).toBe(0);
      };
      const tmux = fakeTmux({ onEnter: () => fire({ subagentType: "explore" }) });
      const a = new GrokRuntimeAdapter({
        tmux: tmux as unknown as TmuxAdapter, fsOps: realFs, stateRoot, grokHome,
        sleep: async () => {}, newSessionId: () => SID, now: () => Date.now(), kill: () => true,
      });
      const r = await a.launchHarness(binding(), { name: "s" });
      expect(r).toMatchObject({ ok: false, recovery: "attention_required" });
      expect(fs.existsSync(grokEventsPath(stateRoot, SID))).toBe(false);
      expect(await a.checkReady(binding())).toMatchObject({ ready: false, code: "awaiting_runtime" });
      fire({});
      expect(await a.checkReady(binding())).toEqual({ ready: true });
    });
  });
});
