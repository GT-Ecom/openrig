// Claude Code opt-in credential-fd delivery: with a credential token file configured, every managed
// launch command (fresh, resume, fork) is typed through the shared launch wrapper, which opens the
// token file on fd 3 and sets CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3. Unset, every command stays
// byte-identical. The daemon fails closed on a malformed OPENRIG_CLAUDE_OAUTH_TOKEN_FILE.

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { spawnSync } from "node:child_process";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter, ExecFn } from "../src/adapters/tmux.js";
import type { CmuxTransportFactory } from "../src/adapters/cmux.js";
import { claudePostureFlag } from "../src/adapters/yolo-mode.js";
import { buildWrappedLaunch } from "../src/adapters/launch-wrapper.js";
import { createDaemon } from "../src/startup.js";

const MODEL = "claude-test-model";
const SID = "11111111-2222-4333-8444-555555555555";
const TOKEN = "oauth-TOKEN-5c1d";
const RENDERER = "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 ";

function mockTmux(): TmuxAdapter {
  return {
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "claude"),
    capturePaneContent: vi.fn(async () => ""),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
  } as unknown as TmuxAdapter;
}

function mockFs(): ClaudeAdapterFsOps {
  return {
    readFile: (p: string) => { throw new Error(`Not found: ${p}`); },
    writeFile: () => {},
    exists: () => false,
    mkdirp: () => {},
    copyFile: () => {},
  };
}

const binding = (model?: string): NodeBinding => ({
  id: "b1", nodeId: "n1", tmuxSession: "r01-impl", tmuxWindow: null, tmuxPane: null,
  cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/project", model,
} as NodeBinding);

const typed = (tmux: TmuxAdapter): string[] =>
  (tmux.sendText as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c[1] as string);

function adapter(tmux: TmuxAdapter, credentialTokenFile?: string): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {}, sessionIdFactory: () => SID, credentialTokenFile });
}

async function launchAll(credentialTokenFile?: string, model: string | undefined = MODEL): Promise<Record<string, string>> {
  const fresh = mockTmux();
  await adapter(fresh, credentialTokenFile).launchHarness(binding(model), { name: "seat" });
  const resume = mockTmux();
  await adapter(resume, credentialTokenFile).launchHarness(binding(model), { name: "seat", resumeToken: "tok-123" });
  const fork = mockTmux();
  await adapter(fork, credentialTokenFile).launchHarness(binding(model), { name: "seat", forkSource: { kind: "native_id", value: "parent-xyz" } });
  return { fresh: typed(fresh).at(-1)!, resume: typed(resume).at(-1)!, fork: typed(fork).at(-1)! };
}

let dir: string;
let tokenPath: string;

beforeAll(() => {
  dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-claude-credfd-"));
  tokenPath = nodePath.join(dir, "oauth token");
  fs.writeFileSync(tokenPath, TOKEN);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("ClaudeCodeAdapter credential-fd launch", () => {
  const posture = () => claudePostureFlag(process.env, undefined);
  const todays = () => ({
    fresh: `${RENDERER}claude ${posture()} --model '${MODEL}' --session-id ${SID} --name seat`,
    resume: `${RENDERER}claude ${posture()} --model '${MODEL}' --resume tok-123 --name seat`,
    fork: `${RENDERER}claude ${posture()} --model '${MODEL}' --resume parent-xyz --fork-session --name seat`,
  });

  it("control, unset: every command is byte-identical to today's", async () => {
    expect(await launchAll(undefined)).toEqual(todays());
  });

  it("types the exact wrapper line for fresh, resume and fork", async () => {
    const got = await launchAll(tokenPath);
    const today = todays();
    for (const kind of ["fresh", "resume", "fork"] as const) {
      const expected = buildWrappedLaunch({
        argv: ["/bin/sh", "-c", "exec env " + today[kind]],
        fds: [{ fd: 3, path: tokenPath }],
        env: { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3" },
      });
      expect(got[kind]).toBe(expected);
      expect(got[kind]).toContain("'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3'");
      expect(got[kind]).toContain(`'F' '3' '${tokenPath}'`);
      expect(got[kind]).not.toContain(TOKEN);
    }
  });

  it("the typed line parses through sh: --model arrives unquoted, the renderer var in env, the token on fd 3", async () => {
    const bin = nodePath.join(dir, "bin");
    fs.mkdirSync(bin, { recursive: true });
    const out = nodePath.join(dir, "claude-out");
    fs.writeFileSync(
      nodePath.join(bin, "claude"),
      [
        "#!/bin/sh",
        `out=${JSON.stringify(out)}`,
        'for a in "$@"; do printf "ARG=%s\\n" "$a"; done >"$out"',
        'printf "RENDERER=%s\\n" "$CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN" >>"$out"',
        'printf "FDVAR=%s\\n" "$CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR" >>"$out"',
        'printf "FD3=%s\\n" "$(cat <&3)" >>"$out"',
      ].join("\n") + "\n",
      { mode: 0o755 },
    );
    const got = await launchAll(tokenPath);
    for (const kind of ["fresh", "resume", "fork"] as const) {
      fs.rmSync(out, { force: true });
      const r = spawnSync("/bin/sh", ["-c", got[kind]], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir }, encoding: "utf8" });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      const lines = fs.readFileSync(out, "utf8").split("\n");
      const args = lines.filter((l) => l.startsWith("ARG=")).map((l) => l.slice(4));
      expect(args[args.indexOf("--model") + 1]).toBe(MODEL);
      expect(args.join(" ")).not.toContain("'");
      expect(lines).toContain("RENDERER=1");
      expect(lines).toContain("FDVAR=3");
      expect(lines).toContain(`FD3=${TOKEN}`);
    }
  });
});

describe("createDaemon: OPENRIG_CLAUDE_OAUTH_TOKEN_FILE fails closed", () => {
  const cmuxFactory: CmuxTransportFactory = async () => {
    throw Object.assign(new Error("no socket"), { code: "ENOENT" });
  };
  const tmuxExec: ExecFn = async () => "";
  let saved: Record<string, string | undefined>;

  beforeAll(() => {
    saved = { OPENRIG_NO_KERNEL: process.env.OPENRIG_NO_KERNEL, OPENRIG_CLAUDE_OAUTH_TOKEN_FILE: process.env.OPENRIG_CLAUDE_OAUTH_TOKEN_FILE };
    process.env.OPENRIG_NO_KERNEL = "1";
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // Closes a daemon that was (wrongly) created, so a failing case reports cleanly.
  async function createDaemonError(): Promise<string> {
    try {
      const { db } = await createDaemon({ cmuxFactory, tmuxExec });
      db.close();
      return "createDaemon did not throw";
    } catch (err) {
      return (err as Error).message;
    }
  }

  it("throws naming the variable when it is a relative path", async () => {
    process.env.OPENRIG_CLAUDE_OAUTH_TOKEN_FILE = "relative/token";
    expect(await createDaemonError()).toMatch(/OPENRIG_CLAUDE_OAUTH_TOKEN_FILE/);
  }, 30000);

  it("throws naming the variable when it is empty", async () => {
    process.env.OPENRIG_CLAUDE_OAUTH_TOKEN_FILE = "";
    expect(await createDaemonError()).toMatch(/OPENRIG_CLAUDE_OAUTH_TOKEN_FILE/);
  }, 30000);

  it("wires an absolute path into the Claude adapter", async () => {
    process.env.OPENRIG_CLAUDE_OAUTH_TOKEN_FILE = tokenPath;
    const { db, deps } = await createDaemon({ cmuxFactory, tmuxExec });
    try {
      const claude = deps.runtimeAdapters!["claude-code"] as unknown as { credentialTokenFile?: string };
      expect(claude.credentialTokenFile).toBe(tokenPath);
    } finally {
      db.close();
      delete process.env.OPENRIG_CLAUDE_OAUTH_TOKEN_FILE;
    }
  }, 30000);
});
