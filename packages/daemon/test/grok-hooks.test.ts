// The grok session hook: a global hook file per daemon state root whose command records
// SessionStart/Stop/SessionEnd for OpenRig's own sessions only (gated on a marker file the adapter
// writes before launch). The generated command runs here through a real `sh`, as grok would run it.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { spawnSync } from "node:child_process";
import {
  grokHookFileName, grokHookFile, ensureGrokHookInstalled,
  readGrokSessionEvents, readGrokActiveSession, type GrokFsOps,
} from "../src/adapters/grok-hooks.js";

const SID = "0b7c6a52-3f1e-4d2a-9c8b-1a2b3c4d5e6f";
const OTHER = "9f9f9f9f-0000-4000-8000-000000000001";

let dir: string;
let writes: string[];

function realFs(): GrokFsOps {
  return {
    readFile: (p) => fs.readFileSync(p, "utf8"),
    writeFile: (p, c) => { writes.push(p); fs.writeFileSync(p, c); },
    exists: (p) => fs.existsSync(p),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
  };
}

function hookCommand(stateRoot: string, event = "SessionStart"): string {
  const parsed = JSON.parse(grokHookFile(stateRoot));
  return parsed.hooks[event][0].hooks[0].command;
}

function runHook(stateRoot: string, env: Record<string, string>, stdin: string) {
  return spawnSync("/bin/sh", ["-c", hookCommand(stateRoot)], {
    env: { PATH: "/usr/bin:/bin", ...env },
    input: stdin,
    encoding: "utf8",
  });
}

function eventsFile(stateRoot: string, id = SID): string {
  return nodePath.join(stateRoot, "sessions", `${id}.events.jsonl`);
}

function mark(stateRoot: string, id = SID): void {
  fs.mkdirSync(nodePath.join(stateRoot, "expect"), { recursive: true });
  fs.writeFileSync(nodePath.join(stateRoot, "expect", id), "");
}

const envelope = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ sessionId: SID, cwd: "/work", hookEventName: "SessionStart", permissionMode: "bypassPermissions", ...extra });

beforeEach(() => {
  dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-grok-hooks-"));
  writes = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("grok hook file", () => {
  it("declares SessionStart, Stop and SessionEnd as explicit /bin/sh commands with a 5s timeout", () => {
    const stateRoot = nodePath.join(dir, "state");
    const parsed = JSON.parse(grokHookFile(stateRoot));
    for (const event of ["SessionStart", "Stop", "SessionEnd"]) {
      const hook = parsed.hooks[event][0].hooks[0];
      expect(hook.type).toBe("command");
      expect(hook.timeout).toBe(5);
      expect(hook.command.startsWith("/bin/sh -c '")).toBe(true);
      expect(hook.command.endsWith(` openrig-hook '${stateRoot}'`)).toBe(true);
    }
    expect(grokHookFileName(stateRoot)).toMatch(/^openrig-session-[0-9a-f]{12}\.json$/);
    expect(grokHookFileName(stateRoot)).not.toBe(grokHookFileName(stateRoot + "2"));
  });

  it("records one parseable line with the envelope's permissionMode; prints {} and exits 0 (stateRoot with a space and a quote)", () => {
    const stateRoot = nodePath.join(dir, "state root 'q'");
    mark(stateRoot);
    const r = runHook(stateRoot, { GROK_HOOK_EVENT: "session_start", GROK_SESSION_ID: SID }, envelope());
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("{}");
    const lines = fs.readFileSync(eventsFile(stateRoot), "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const ev = JSON.parse(lines[0]!);
    expect(ev).toMatchObject({ event: "session_start", sessionId: SID, permissionMode: "bypassPermissions" });
    expect(typeof ev.at_s).toBe("number");
    expect(readGrokSessionEvents(realFs(), stateRoot, SID).map((e) => e.event)).toEqual(["session_start"]);
  });

  it("keeps permissionMode only when it is letters", () => {
    const stateRoot = nodePath.join(dir, "state");
    mark(stateRoot);
    runHook(stateRoot, { GROK_HOOK_EVENT: "stop", GROK_SESSION_ID: SID }, envelope({ permissionMode: "by pass$(x)" }));
    const ev = JSON.parse(fs.readFileSync(eventsFile(stateRoot), "utf8").trim());
    expect(ev.permissionMode).toBe("");
  });

  describe("controls: each writes nothing and still exits 0 with {}", () => {
    const cases: Array<[string, (root: string) => ReturnType<typeof runHook>]> = [
      ["no marker", (root) => runHook(root, { GROK_HOOK_EVENT: "session_start", GROK_SESSION_ID: SID }, envelope())],
      ["a non-UUID id", (root) => { mark(root, "not-a-uuid"); return runHook(root, { GROK_HOOK_EVENT: "session_start", GROK_SESSION_ID: "not-a-uuid" }, envelope()); }],
      ["an event name with a quote", (root) => { mark(root); return runHook(root, { GROK_HOOK_EVENT: "session_start\"", GROK_SESSION_ID: SID }, envelope()); }],
      ["an envelope carrying subagentType", (root) => { mark(root); return runHook(root, { GROK_HOOK_EVENT: "session_start", GROK_SESSION_ID: SID }, envelope({ subagentType: "explore" })); }],
    ];
    for (const [name, act] of cases) {
      it(name, () => {
        const stateRoot = nodePath.join(dir, "state");
        fs.mkdirSync(stateRoot, { recursive: true });
        const r = act(stateRoot);
        expect(r.status).toBe(0);
        expect(r.stdout).toBe("{}");
        expect(fs.existsSync(nodePath.join(stateRoot, "sessions"))).toBe(false);
      });
    }
  });

  it("reader: keeps line order and ignores a torn last line", () => {
    const stateRoot = nodePath.join(dir, "state");
    fs.mkdirSync(nodePath.join(stateRoot, "sessions"), { recursive: true });
    fs.writeFileSync(
      eventsFile(stateRoot),
      [
        JSON.stringify({ event: "session_start", sessionId: SID, at_s: 200, permissionMode: "" }),
        JSON.stringify({ event: "session_end", sessionId: SID, at_s: 100, permissionMode: "" }),
        '{"event": "session_st',
      ].join("\n"),
    );
    expect(readGrokSessionEvents(realFs(), stateRoot, SID).map((e) => e.event)).toEqual(["session_start", "session_end"]);
    expect(readGrokSessionEvents(realFs(), stateRoot, OTHER)).toEqual([]);
  });

  it("two daemons: two files; reinstalling one changes nothing and never touches a neighbour", () => {
    const grokHome = nodePath.join(dir, "grok-home");
    const hooksDir = nodePath.join(grokHome, "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    const neighbour = nodePath.join(hooksDir, "user-hooks.json");
    fs.writeFileSync(neighbour, '{"hooks": {}}');
    const a = nodePath.join(dir, "daemon-a");
    const b = nodePath.join(dir, "daemon-b");
    expect(ensureGrokHookInstalled(realFs(), grokHome, a)).toBe(true);
    expect(ensureGrokHookInstalled(realFs(), grokHome, b)).toBe(true);
    expect(fs.readdirSync(hooksDir).sort()).toEqual([grokHookFileName(a), grokHookFileName(b), "user-hooks.json"].sort());
    writes = [];
    expect(ensureGrokHookInstalled(realFs(), grokHome, a)).toBe(false);
    expect(writes).toEqual([]);
    expect(fs.readFileSync(neighbour, "utf8")).toBe('{"hooks": {}}');
    expect(fs.readFileSync(nodePath.join(hooksDir, grokHookFileName(a)), "utf8")).toBe(grokHookFile(a));
  });

  it("active_sessions.json: finds an entry; a missing or garbage file returns null", () => {
    const grokHome = nodePath.join(dir, "grok-home");
    expect(readGrokActiveSession(realFs(), grokHome, SID)).toBeNull();
    fs.mkdirSync(grokHome, { recursive: true });
    const file = nodePath.join(grokHome, "active_sessions.json");
    fs.writeFileSync(file, "not json{");
    expect(readGrokActiveSession(realFs(), grokHome, SID)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ sessions: "weird" }));
    expect(readGrokActiveSession(realFs(), grokHome, SID)).toBeNull();
    fs.writeFileSync(file, JSON.stringify([
      { session_id: OTHER, pid: 11, cwd: "/a", opened_at: "2026-09-29T10:00:00Z" },
      { session_id: SID, pid: 42, cwd: "/work", opened_at: "2026-09-29T10:00:05Z" },
    ]));
    expect(readGrokActiveSession(realFs(), grokHome, SID)).toMatchObject({ session_id: SID, pid: 42, cwd: "/work" });
  });
});
