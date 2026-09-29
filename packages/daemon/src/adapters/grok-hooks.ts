// The grok session hook and its readers.
//
// Global hook files ($GROK_HOME/hooks/*.json) are always trusted; project hooks need an
// interactive trust grant, so OpenRig installs ONE global file per daemon state root
// (openrig-session-<sha256(stateRoot) prefix>.json) and never touches any other file there.
//
// The hook command is an explicit `/bin/sh -c '<FIXED_HOOK_SCRIPT>' openrig-hook <stateRoot>`
// (the shell grok runs an inline hook command through is not documented; fish or nu must not
// break it). The state root arrives as $1, never spliced into the script. The script always
// prints `{}` and exits 0, so it can never block grok, and records an event only when:
//   - the envelope on stdin has no "subagentType" (hooks also run inside a subagent's session);
//   - GROK_SESSION_ID is UUID-shaped and GROK_HOOK_EVENT matches ^[a-z_]+$;
//   - the marker <stateRoot>/expect/<id> exists (the adapter creates it before launch). The gate
//     is the marker, never an env var: grok can run a shared leader process, so a hook's env is
//     not proven to belong to the launching TUI.
// Each event appends one JSON line to <stateRoot>/sessions/<id>.events.jsonl, carrying the
// envelope's permissionMode (letters only, else "") so a live check can see the mode grok runs in.

import nodePath from "node:path";
import { createHash } from "node:crypto";
import { shellQuote } from "./shell-quote.js";

export interface GrokFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  /** Byte size of a file. Optional: falls back to the UTF-8 byte length of readFile. */
  fileSize?(path: string): number;
}

export interface GrokSessionEvent {
  event: string;
  sessionId: string;
  at_s: number;
  permissionMode: string;
}

export interface GrokActiveSession {
  session_id: string;
  pid: number;
  cwd: string | null;
  opened_at: unknown;
}

export const GROK_HOOK_EVENTS = ["SessionStart", "Stop", "SessionEnd"] as const;

const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

export function isUuidShaped(value: string): boolean {
  return UUID_RE.test(value);
}

export const FIXED_HOOK_SCRIPT = [
  'in=$(cat); printf "{}";',
  'if printf "%s" "$in" | grep -q "\\"subagentType\\""; then exit 0; fi;',
  'id=${GROK_SESSION_ID:-}; ev=${GROK_HOOK_EVENT:-};',
  'case $ev in ""|*[!a-z_]*) exit 0;; esac;',
  'case $id in *[!0-9A-Fa-f-]*) exit 0;; esac;',
  'printf "%s" "$id" | grep -Eq "^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$" || exit 0;',
  '[ -f "$1/expect/$id" ] || exit 0;',
  'm=$(printf "%s" "$in" | sed -n "s/.*\\"permissionMode\\"[[:space:]]*:[[:space:]]*\\"\\([A-Za-z]*\\)\\".*/\\1/p" | head -n 1);',
  'case $m in *[!A-Za-z]*) m="";; esac;',
  'mkdir -p "$1/sessions" 2>/dev/null;',
  'printf "{\\"event\\": \\"%s\\", \\"sessionId\\": \\"%s\\", \\"at_s\\": %s, \\"permissionMode\\": \\"%s\\"}\\n" "$ev" "$id" "$(date +%s)" "$m" >>"$1/sessions/$id.events.jsonl" 2>/dev/null;',
  "exit 0",
].join(" ");

export function grokHookFileName(stateRoot: string): string {
  const digest = createHash("sha256").update(stateRoot).digest("hex").slice(0, 12);
  return `openrig-session-${digest}.json`;
}

export function grokHookCommand(stateRoot: string): string {
  return `/bin/sh -c ${shellQuote(FIXED_HOOK_SCRIPT)} openrig-hook ${shellQuote(stateRoot)}`;
}

export function grokHookFile(stateRoot: string): string {
  const command = grokHookCommand(stateRoot);
  const hooks: Record<string, unknown> = {};
  for (const event of GROK_HOOK_EVENTS) {
    hooks[event] = [{ hooks: [{ type: "command", command, timeout: 5 }] }];
  }
  return JSON.stringify({ hooks }, null, 2) + "\n";
}

export function grokMarkerPath(stateRoot: string, sessionId: string): string {
  return nodePath.join(stateRoot, "expect", sessionId);
}

export function grokEventsPath(stateRoot: string, sessionId: string): string {
  return nodePath.join(stateRoot, "sessions", `${sessionId}.events.jsonl`);
}

/** Writes this daemon's hook file only when its content differs. Returns whether it wrote. */
export function ensureGrokHookInstalled(fs: GrokFsOps, grokHome: string, stateRoot: string): boolean {
  const hooksDir = nodePath.join(grokHome, "hooks");
  const target = nodePath.join(hooksDir, grokHookFileName(stateRoot));
  const content = grokHookFile(stateRoot);
  if (fs.exists(target)) {
    try {
      if (fs.readFile(target) === content) return false;
    } catch { /* unreadable: rewrite it */ }
  }
  fs.mkdirp(hooksDir);
  fs.writeFile(target, content);
  return true;
}

export function byteSize(fs: GrokFsOps, path: string): number {
  if (!fs.exists(path)) return 0;
  if (fs.fileSize) return fs.fileSize(path);
  return Buffer.byteLength(fs.readFile(path), "utf8");
}

/**
 * The session's hook events in LINE order (never ordered by at_s). A torn or unparseable line is
 * ignored. `sinceByte` skips the bytes an earlier run wrote (the launch baseline); a file shorter
 * than the baseline was replaced, so it is read whole.
 */
export function readGrokSessionEvents(
  fs: GrokFsOps,
  stateRoot: string,
  sessionId: string,
  sinceByte = 0,
): GrokSessionEvent[] {
  if (!isUuidShaped(sessionId)) return [];
  const path = grokEventsPath(stateRoot, sessionId);
  let text: string;
  try {
    if (!fs.exists(path)) return [];
    text = fs.readFile(path);
  } catch {
    return [];
  }
  const bytes = Buffer.from(text, "utf8");
  if (sinceByte > 0 && sinceByte <= bytes.length) text = bytes.subarray(sinceByte).toString("utf8");
  const events: GrokSessionEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const e = parsed as Record<string, unknown>;
    if (typeof e.event !== "string" || e.sessionId !== sessionId) continue;
    events.push({
      event: e.event,
      sessionId,
      at_s: typeof e.at_s === "number" ? e.at_s : NaN,
      permissionMode: typeof e.permissionMode === "string" ? e.permissionMode : "",
    });
  }
  return events;
}

/**
 * The $GROK_HOME/active_sessions.json entry for a session, or null. The format is UNDOCUMENTED,
 * so a missing, unparseable or differently-shaped file (or entry) is null, never a throw.
 */
export function readGrokActiveSession(fs: GrokFsOps, grokHome: string, sessionId: string): GrokActiveSession | null {
  const path = nodePath.join(grokHome, "active_sessions.json");
  let parsed: unknown;
  try {
    if (!fs.exists(path)) return null;
    parsed = JSON.parse(fs.readFile(path));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e.session_id !== sessionId) continue;
    if (typeof e.pid !== "number" || !Number.isInteger(e.pid) || e.pid <= 0) continue;
    return { session_id: sessionId, pid: e.pid, cwd: typeof e.cwd === "string" ? e.cwd : null, opened_at: e.opened_at };
  }
  return null;
}

/** An active_sessions `opened_at` as epoch ms, or null when it cannot be parsed. Numbers below
 *  1e12 are taken as seconds, larger ones as milliseconds; strings go through Date.parse. */
export function parseOpenedAt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    if (/^\d+(\.\d+)?$/.test(value.trim())) return parseOpenedAt(Number(value.trim()));
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}
