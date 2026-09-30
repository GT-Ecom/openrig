// Wiring of the Pi agent-dir template into the launch adapter, the resume
// adapter and daemon startup. Fake tmux (as pi-runtime-adapter.test.ts does),
// real temp dirs for the seat state so the seeding itself is real.

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { PiRuntimeAdapter, type PiAdapterFsOps } from "../src/adapters/pi-runtime-adapter.js";
import { PiResumeAdapter } from "../src/adapters/pi-resume.js";
import { piSeatPaths } from "../src/adapters/pi-runner-protocol.js";
import { PI_AGENT_TEMPLATE_DIRNAME } from "../src/adapters/pi-agent-template.js";
import { createDaemon } from "../src/startup.js";
import { OPENRIG_HOME } from "../src/openrig-compat.js";
import type { CmuxTransportFactory } from "../src/adapters/cmux.js";
import type { ExecFn } from "../src/adapters/tmux.js";

const SENTINEL = "sk-sentinel-wiring-9c21";
const RUNNER = "/daemon-dist/adapters/pi-runner.js";
const SESSION = "devpi-a@some-rig";

let root: string;
let stateRoot: string;
let templateDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-pi-wiring-"));
  stateRoot = nodePath.join(root, "state", "pi");
  templateDir = nodePath.join(root, PI_AGENT_TEMPLATE_DIRNAME);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const realFs: PiAdapterFsOps = {
  readFile: (p) => fs.readFileSync(p, "utf-8"),
  writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
  exists: (p) => fs.existsSync(p),
  mkdirp: (p) => { fs.mkdirSync(p, { recursive: true }); },
  listFiles: () => [],
};

function goodTemplate(): void {
  fs.mkdirSync(templateDir, { recursive: true });
  fs.writeFileSync(nodePath.join(templateDir, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: SENTINEL } }));
  fs.writeFileSync(nodePath.join(templateDir, "settings.json"), JSON.stringify({ defaultProvider: "openrouter" }));
}

function badTemplate(): void {
  fs.mkdirSync(templateDir, { recursive: true });
  fs.writeFileSync(nodePath.join(templateDir, "auth.json"), `{ "k": "${SENTINEL}" `);
}

function launchIdFrom(cmd: string): string {
  const m = /--launch-id '([^']+)'/.exec(cmd);
  if (!m) throw new Error("typed command carries no --launch-id");
  return m[1]!;
}

/** A fake tmux whose sendText records what the adapter typed and what was on
 *  disk at that moment, then plays the runner by writing a ready sidecar. */
function fakeTmux(sessionFile: string) {
  const typed: string[] = [];
  const agentDirAtSend: string[][] = [];
  const pendingSidecarAtSend: string[] = [];
  const sendText = vi.fn(async (_t: string, text: string): Promise<TmuxResult> => {
    typed.push(text);
    const paths = piSeatPaths(stateRoot, SESSION);
    agentDirAtSend.push(fs.existsSync(paths.agentDir) ? fs.readdirSync(paths.agentDir).sort() : []);
    pendingSidecarAtSend.push(fs.readFileSync(paths.runnerStatePath, "utf-8"));
    fs.writeFileSync(paths.runnerStatePath, JSON.stringify({
      ready: true, launchId: launchIdFrom(text), sessionFile, sessionId: "0197a2f0", updatedAt: "2026-07-06T10:00:01Z",
    }));
    return { ok: true };
  });
  const sendKeys = vi.fn(async (): Promise<TmuxResult> => ({ ok: true }));
  const tmux = {
    sendText,
    sendKeys,
    capturePaneContent: vi.fn(async () => ""),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "node"),
  } as unknown as TmuxAdapter;
  return { tmux, sendText, sendKeys, typed, agentDirAtSend, pendingSidecarAtSend };
}

function launchAdapter(tmux: TmuxAdapter, agentTemplateDir?: string) {
  return new PiRuntimeAdapter({
    tmux, fsOps: realFs, stateRoot, runnerEntryPath: RUNNER, sleep: async () => {}, agentTemplateDir,
  });
}

function sessionFilePath(): string {
  return nodePath.join(piSeatPaths(stateRoot, SESSION).sessionsDir, "2026-07-06T10-00-00_0197a2f0.jsonl");
}

const binding = () => ({ tmuxSession: SESSION, cwd: "/work", model: "openrouter/some-model" }) as never;

describe("PiRuntimeAdapter agent template wiring", () => {
  it("without agentTemplateDir the typed command and the agent dir are exactly today's", async () => {
    goodTemplate(); // present on disk but not wired: must be ignored
    const without = fakeTmux(sessionFilePath());
    const r1 = await launchAdapter(without.tmux).launchHarness(binding(), { name: SESSION });
    expect(r1.ok).toBe(true);
    expect(without.agentDirAtSend[0]).toEqual([]);
    const agentDir = piSeatPaths(stateRoot, SESSION).agentDir;
    expect(fs.readdirSync(agentDir)).toEqual([]);

    // Control: with the dep set, the files appear and the command is otherwise the same.
    fs.rmSync(nodePath.join(root, "state"), { recursive: true, force: true });
    const withDep = fakeTmux(sessionFilePath());
    const r2 = await launchAdapter(withDep.tmux, templateDir).launchHarness(binding(), { name: SESSION });
    expect(r2.ok).toBe(true);
    expect(withDep.agentDirAtSend[0]).toEqual(["auth.json", "settings.json"]);
    const strip = (cmd: string) => cmd.replace(/--launch-id '[^']+'/, "--launch-id X");
    expect(strip(withDep.typed[0]!)).toBe(strip(without.typed[0]!));
  });

  it("a seed failure returns ok:false with attention_required and types nothing", async () => {
    badTemplate();
    const t = fakeTmux(sessionFilePath());
    const result = await launchAdapter(t.tmux, templateDir).launchHarness(binding(), { name: SESSION });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.startsWith("pi launch: agent template: ")).toBe(true);
      expect(result.error).not.toContain(SENTINEL);
      expect(result.recovery).toBe("attention_required");
    }
    expect(t.sendText).not.toHaveBeenCalled();
    expect(t.sendKeys).not.toHaveBeenCalled();

    // Control: a good template reaches sendText.
    fs.rmSync(templateDir, { recursive: true });
    goodTemplate();
    const ok = fakeTmux(sessionFilePath());
    const r = await launchAdapter(ok.tmux, templateDir).launchHarness(binding(), { name: SESSION });
    expect(r.ok).toBe(true);
    expect(ok.sendText).toHaveBeenCalledOnce();
  });

  it("the typed launch command and the pending sidecar never carry the auth.json content", async () => {
    goodTemplate();
    const t = fakeTmux(sessionFilePath());
    const result = await launchAdapter(t.tmux, templateDir).launchHarness(binding(), { name: SESSION });
    expect(result.ok).toBe(true);
    // Control: the sentinel did reach the seat's auth.json.
    expect(fs.readFileSync(nodePath.join(piSeatPaths(stateRoot, SESSION).agentDir, "auth.json"), "utf-8")).toContain(SENTINEL);
    expect(t.typed[0]).not.toContain(SENTINEL);
    expect(t.pendingSidecarAtSend[0]).not.toContain(SENTINEL);
    expect(t.pendingSidecarAtSend[0]).toContain("launchId");
  });
});

describe("PiResumeAdapter agent template wiring", () => {
  function resumeAdapter(tmux: TmuxAdapter, agentTemplateDir?: string) {
    return new PiResumeAdapter(tmux, realFs, { stateRoot, runnerEntryPath: RUNNER }, {
      pollMs: 1, maxWaitMs: 5, sleep: async () => {}, agentTemplateDir,
    });
  }

  function persistedSession(): string {
    const file = sessionFilePath();
    fs.mkdirSync(nodePath.dirname(file), { recursive: true });
    fs.writeFileSync(file, "jsonl\n");
    return file;
  }

  it("seeds the agent dir before it types the resume command", async () => {
    goodTemplate();
    const file = persistedSession();
    const t = fakeTmux(file);
    const result = await resumeAdapter(t.tmux, templateDir).resume(SESSION, "pi_session_file", file, "/work");
    expect(result.ok).toBe(true);
    expect(t.agentDirAtSend[0]).toEqual(["auth.json", "settings.json"]);
    expect(t.typed[0]).not.toContain(SENTINEL);

    // Control: without the dep it does not seed.
    fs.rmSync(piSeatPaths(stateRoot, SESSION).agentDir, { recursive: true });
    const t2 = fakeTmux(file);
    const r2 = await resumeAdapter(t2.tmux).resume(SESSION, "pi_session_file", file, "/work");
    expect(r2.ok).toBe(true);
    expect(t2.agentDirAtSend[0]).toEqual([]);
  });

  it("a seed error returns resume_failed and types nothing", async () => {
    badTemplate();
    const file = persistedSession();
    const t = fakeTmux(file);
    const result = await resumeAdapter(t.tmux, templateDir).resume(SESSION, "pi_session_file", file, "/work");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("resume_failed");
      expect(result.message.startsWith("pi resume: agent template:")).toBe(true);
      expect(result.message).not.toContain(SENTINEL);
    }
    expect(t.sendText).not.toHaveBeenCalled();

    // Control: a good template resumes.
    fs.rmSync(templateDir, { recursive: true });
    goodTemplate();
    const ok = fakeTmux(file);
    const r = await resumeAdapter(ok.tmux, templateDir).resume(SESSION, "pi_session_file", file, "/work");
    expect(r.ok).toBe(true);
    expect(ok.sendText).toHaveBeenCalledOnce();
  });
});

describe("createDaemon wires the Pi agent template dir", () => {
  const cmuxFactory: CmuxTransportFactory = async () => {
    throw Object.assign(new Error("no socket"), { code: "ENOENT" });
  };
  const tmuxExec: ExecFn = async () => "";
  let savedNoKernel: string | undefined;

  beforeAll(() => {
    savedNoKernel = process.env.OPENRIG_NO_KERNEL;
    process.env.OPENRIG_NO_KERNEL = "1";
  });
  afterAll(() => {
    if (savedNoKernel === undefined) delete process.env.OPENRIG_NO_KERNEL;
    else process.env.OPENRIG_NO_KERNEL = savedNoKernel;
  });

  it("passes <OPENRIG_HOME>/pi-agent-template to the launch and resume adapters", async () => {
    const { db, deps } = await createDaemon({ cmuxFactory, tmuxExec });
    try {
      const expected = nodePath.join(OPENRIG_HOME, "pi-agent-template");
      const pi = deps.runtimeAdapters!["pi"] as unknown as { agentTemplateDir?: string };
      expect(pi).toBeInstanceOf(PiRuntimeAdapter);
      expect(pi.agentTemplateDir).toBe(expected);
      const piResume = (deps.restoreOrchestrator as unknown as { piResume: { options: { agentTemplateDir?: string } } }).piResume;
      expect(piResume).toBeInstanceOf(PiResumeAdapter);
      expect(piResume.options.agentTemplateDir).toBe(expected);
      // Control: a wrong dirname fails the assertion.
      expect(pi.agentTemplateDir).not.toBe(nodePath.join(OPENRIG_HOME, "pi-agent-templates"));
      expect(piResume.options.agentTemplateDir).not.toBe(nodePath.join(OPENRIG_HOME, "pi-agent-templates"));
    } finally {
      db.close();
    }
  }, 30000);
});
