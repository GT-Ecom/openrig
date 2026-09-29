// Acceptance: the credential fd crosses a REAL tmux session. A private tmux server (-L <socket>,
// env without TMUX/TMUX_TMPDIR) and a real TmuxAdapter type the wrapped line into a pane; the
// harness reads fd 3. Controls prove the unwrapped harness has no fd 3, that the interactive
// pane shell never held it, and that neither the pane nor the tmux environment carries the token.
// This test must FAIL (never skip) when tmux is missing.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { buildWrappedLaunch } from "../src/adapters/launch-wrapper.js";

const pexec = promisify(execFile);
const SOCK = `openrig-credfd-${process.pid}-${Date.now()}`;
const TOKEN = "credfd-TOKEN-7e2b90d4";
const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
delete cleanEnv.TMUX;
delete cleanEnv.TMUX_TMPDIR;

// Every tmux command goes to the private socket; never the operator's server.
const exec = async (cmd: string): Promise<string> => {
  const safe = cmd.startsWith("tmux ") ? `tmux -L ${SOCK} ${cmd.slice(5)}` : cmd;
  const { stdout } = await pexec("/bin/sh", ["-c", safe], { env: cleanEnv });
  return stdout;
};
const tmux = (args: string) => exec(`tmux ${args}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HARNESS = `if (: <&3) 2>/dev/null; then cat <&3 >"$OUT"; else echo NOFD >"$OUT"; fi`;

function tmuxOnPath(): boolean {
  try {
    execFileSync("/bin/sh", ["-c", "command -v tmux"], { env: cleanEnv, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let dir: string;
let tokenPath: string;
const sessions: string[] = [];

async function waitForFile(path: string, ms = 10000): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fs.existsSync(path)) {
      const text = fs.readFileSync(path, "utf8");
      if (text.length > 0) return text;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function newSession(name: string): Promise<void> {
  sessions.push(name);
  await tmux(`new-session -d -s ${shellQuote(name)} -x 200 -y 50 -c ${shellQuote(dir)} /bin/sh`);
  await sleep(150);
}

beforeAll(() => {
  dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-credfd-tmux-"));
  tokenPath = nodePath.join(dir, "token-file");
  fs.writeFileSync(tokenPath, TOKEN);
});

afterAll(async () => {
  // Kill only our own sessions, by name; the private server exits with its last session.
  for (const s of sessions) await tmux(`kill-session -t ${shellQuote(s)}`).catch(() => {});
  for (let i = 0; i < 40; i++) {
    const alive = await tmux("list-sessions").then(() => true, () => false);
    if (!alive) break;
    await sleep(50);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("credential fd through a real tmux pane", () => {
  it("delivers the token on fd 3 to the harness, and only to it", async () => {
    if (!tmuxOnPath()) throw new Error("tmux is required for the credential-fd acceptance test");
    const adapter = new TmuxAdapter((cmd) => exec(cmd));

    // Wrapped launch.
    const wrappedSession = "credfd-wrapped";
    await newSession(wrappedSession);
    const outWrapped = nodePath.join(dir, "out-wrapped");
    const line = buildWrappedLaunch({
      argv: ["/bin/sh", "-c", HARNESS],
      env: { OUT: outWrapped },
      fds: [{ fd: 3, path: tokenPath }],
    });
    expect((await adapter.sendText(wrappedSession, line)).ok).toBe(true);
    expect((await adapter.sendKeys(wrappedSession, ["Enter"])).ok).toBe(true);
    expect(await waitForFile(outWrapped)).toBe(TOKEN);

    // Control, fd leak: the unwrapped harness typed into the SAME pane has no fd 3.
    const outSamePane = nodePath.join(dir, "out-same-pane");
    const unwrapped = (out: string) => `OUT=${shellQuote(out)} /bin/sh -c ${shellQuote(HARNESS)}`;
    expect((await adapter.sendText(wrappedSession, unwrapped(outSamePane))).ok).toBe(true);
    expect((await adapter.sendKeys(wrappedSession, ["Enter"])).ok).toBe(true);
    expect((await waitForFile(outSamePane)).trim()).toBe("NOFD");

    // Control, no wrapper: the same harness in a fresh session has no fd 3.
    const plainSession = "credfd-plain";
    await newSession(plainSession);
    const outPlain = nodePath.join(dir, "out-plain");
    expect((await adapter.sendText(plainSession, unwrapped(outPlain))).ok).toBe(true);
    expect((await adapter.sendKeys(plainSession, ["Enter"])).ok).toBe(true);
    expect((await waitForFile(outPlain)).trim()).toBe("NOFD");

    // No leak into tmux: the token never reaches the pane, and neither the token nor its path
    // reaches the tmux environment. (The typed line itself carries the PATH by design.)
    const capture = await tmux(`capture-pane -p -S - -t ${shellQuote(wrappedSession)}`);
    expect(capture).toContain("openrig-launch");
    expect(capture).not.toContain(TOKEN);
    const globalEnv = await tmux("show-environment -g");
    const sessionEnv = await tmux(`show-environment -t ${shellQuote(wrappedSession)}`);
    for (const env of [globalEnv, sessionEnv]) {
      expect(env).not.toContain(TOKEN);
      expect(env).not.toContain(tokenPath);
    }
  });
});
