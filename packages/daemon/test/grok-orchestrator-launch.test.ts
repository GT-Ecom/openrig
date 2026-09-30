import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { StartupOrchestrator, type StartupInput } from "../src/domain/startup-orchestrator.js";
import { GrokRuntimeAdapter, grokSeatPaths, type GrokAdapterFsOps } from "../src/adapters/grok-runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RuntimeAdapter, NodeBinding, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { StartupAction } from "../src/domain/types.js";

const SID = "0b7c6a52-3f1e-4d2a-9c8b-1a2b3c4d5e6f";
const SESSION = "dev-grok@test-rig";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const binding = (): NodeBinding => ({ id: "b", nodeId: "n", tmuxSession: SESSION, tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, cwd: "/work", updatedAt: "", launchPosture: "floor" } as NodeBinding);
const identity = (): StartupAction => ({ type: "send_text", value: "OpenRig session identity:\n- session: dev-grok", phase: "after_ready", appliesOn: ["fresh_start", "restore"], idempotent: true, builtin: "session_identity" });
const action = (type: "send_text" | "slash_command", value: string): StartupAction => ({ type, value, phase: "after_ready", appliesOn: ["fresh_start", "restore"], idempotent: true });

describe("grok startup orchestration", () => {
  it("puts startup files in rules and startup text in the launch prompt without pasting it", async () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-grok-orchestrator-")); dirs.push(dir);
    const stateRoot = nodePath.join(dir, "state"); const grokHome = nodePath.join(dir, "grok-home");
    const rolePath = nodePath.join(dir, "role.md"); const guidancePath = nodePath.join(dir, "guidance.md");
    fs.writeFileSync(rolePath, "ROLE TEXT"); fs.writeFileSync(guidancePath, "GUIDANCE TEXT");
    const paths = grokSeatPaths(stateRoot, SESSION);
    let rulesAtLaunch = ""; let promptAtLaunch = ""; const sent: string[] = [];
    const tmux = {
      sendText: vi.fn(async (_session: string, text: string) => { sent.push(text); return { ok: true as const }; }),
      sendKeys: vi.fn(async (_session: string, keys: string[]) => {
        if (keys.includes("Enter") && sent.length === 1) {
          rulesAtLaunch = fs.readFileSync(paths.standingInstructions, "utf8");
          const promptPath = nodePath.join(paths.seatDir, "initial-prompt.md");
          promptAtLaunch = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, "utf8") : "";
          fs.mkdirSync(grokHome, { recursive: true });
          fs.writeFileSync(nodePath.join(grokHome, "active_sessions.json"), JSON.stringify([{ session_id: SID, pid: 7, opened_at: new Date().toISOString() }]));
        }
        return { ok: true as const };
      }),
      hasSession: vi.fn(async () => true), getPaneCommand: vi.fn(async () => "grok"), capturePaneContent: vi.fn(async () => ""),
    } as unknown as TmuxAdapter;
    const fsOps: GrokAdapterFsOps = {
      readFile: (p) => fs.readFileSync(p, "utf8"), writeFile: (p, c) => { fs.mkdirSync(nodePath.dirname(p), { recursive: true }); fs.writeFileSync(p, c); },
      exists: (p) => fs.existsSync(p), mkdirp: (p) => fs.mkdirSync(p, { recursive: true }), fileSize: (p) => fs.statSync(p).size,
      listFiles: (p) => fs.existsSync(p) ? fs.readdirSync(p) : [],
    };
    const adapter = new GrokRuntimeAdapter({ tmux, fsOps, stateRoot, grokHome, newSessionId: () => SID, sleep: async () => {}, isPidAlive: () => true });
    const db = createFullTestDb();
    try {
      const sessions = new SessionRegistry(db); const events = new EventBus(db); const repo = new RigRepository(db);
      const rig = repo.createRig("test-rig"); const node = repo.addNode(rig.id, "grok", { runtime: "grok" }); const session = sessions.registerSession(node.id, SESSION); sessions.updateStatus(session.id, "running");
      const files: ResolvedStartupFile[] = [
        { path: "role.md", absolutePath: rolePath, ownerRoot: dir, deliveryHint: "send_text", required: true, appliesOn: ["fresh_start", "restore"] },
        { path: "guidance.md", absolutePath: guidancePath, ownerRoot: dir, deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start", "restore"] },
      ];
      const input: StartupInput = { rigId: rig.id, nodeId: node.id, sessionId: session.id, binding: { ...binding(), nodeId: node.id }, adapter, plan: { runtime: "grok", cwd: "/work", entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] }, resolvedStartupFiles: files, startupActions: [identity(), action("send_text", "ACTION TEXT"), action("slash_command", "/status")], isRestore: false };
      const result = await new StartupOrchestrator({ db, sessionRegistry: sessions, eventBus: events, tmuxAdapter: tmux, readFile: (p) => fs.readFileSync(p, "utf8"), sleep: async () => {} }).startNode(input);
      expect(result.ok).toBe(true);
      expect(rulesAtLaunch).toContain("ROLE TEXT");
      expect(rulesAtLaunch).toContain("GUIDANCE TEXT");
      expect(promptAtLaunch).toBe(`${identity().value}\n\nACTION TEXT`);
      expect(sent).toHaveLength(2);
      expect(sent[1]).toBe("/status");
      expect(sent.join("\n")).not.toContain("ROLE TEXT");
      expect(sent.join("\n")).not.toContain("ACTION TEXT");
    } finally { db.close(); }
  });

  it("does not pass initialPrompt to an adapter using default TUI delivery", async () => {
    const db = createFullTestDb();
    try {
      const sessions = new SessionRegistry(db); const events = new EventBus(db); const repo = new RigRepository(db);
      const rig = repo.createRig("tui-rig"); const node = repo.addNode(rig.id, "seat", { runtime: "claude-code" }); const session = sessions.registerSession(node.id, SESSION); sessions.updateStatus(session.id, "running");
      const launch = vi.fn<RuntimeAdapter["launchHarness"]>(async () => ({ ok: true }));
      const adapter: RuntimeAdapter = { runtime: "claude-code", listInstalled: async () => [], project: async () => ({ projected: [], skipped: [], failed: [] }), deliverStartup: async () => ({ delivered: 0, failed: [] }), launchHarness: launch, checkReady: async () => ({ ready: true }) };
      const tmux = { sendText: vi.fn(async () => ({ ok: true as const })), sendKeys: vi.fn(async () => ({ ok: true as const })) } as unknown as TmuxAdapter;
      await new StartupOrchestrator({ db, sessionRegistry: sessions, eventBus: events, tmuxAdapter: tmux, readFile: () => "ROLE TEXT", sleep: async () => {} }).startNode({ rigId: rig.id, nodeId: node.id, sessionId: session.id, binding: { ...binding(), nodeId: node.id }, adapter, plan: { runtime: "claude-code", cwd: "/work", entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] }, resolvedStartupFiles: [{ path: "role.md", absolutePath: "/role", ownerRoot: "/", deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] }], startupActions: [identity()], isRestore: false });
      expect(launch.mock.calls[0]?.[1]).not.toHaveProperty("initialPrompt");
      expect(tmux.sendText).toHaveBeenCalledWith(SESSION, `${identity().value}\n\nROLE TEXT`);
    } finally { db.close(); }
  });
});
