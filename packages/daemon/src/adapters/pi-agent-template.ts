// Pi seat agent-dir seeding from an operator template.
//
// `<OPENRIG_HOME>/pi-agent-template/` may hold Pi's `auth.json`,
// `settings.json` and `models.json`. Each launch copies exactly those files
// into the seat's agent dir (PI_CODING_AGENT_DIR), so a provider credential
// can reach Pi through `auth.json` (whose `!command` form Pi resolves itself)
// instead of through the daemon, tmux, pane, argv or child environment.
//
// Nothing else in the template is ever copied: a SYSTEM.md, AGENTS.md or
// extensions/ there would change the seat's prompt or run code. Errors carry
// paths and errno codes only — never anything read from a file.

import fs from "node:fs";
import nodePath from "node:path";
import { randomBytes } from "node:crypto";

export const PI_AGENT_TEMPLATE_DIRNAME = "pi-agent-template";
export const PI_AGENT_TEMPLATE_FILES = ["auth.json", "settings.json", "models.json"] as const;

export type SeedResult =
  | {
    ok: true;
    /** False when the template dir does not exist; the agent dir is then untouched. */
    templatePresent: boolean;
    copied: string[];
    /** Allowlisted files deleted from the agent dir because the template no longer holds them. */
    removed: string[];
    /** Template entries outside the allowlist; never copied. */
    ignored: string[];
  }
  | { ok: false; error: string };

function errnoCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : "unknown error";
}

export function seedPiAgentDir(templateDir: string, agentDir: string): SeedResult {
  let dirStat: fs.Stats;
  try {
    dirStat = fs.lstatSync(templateDir);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") {
      return { ok: true, templatePresent: false, copied: [], removed: [], ignored: [] };
    }
    return { ok: false, error: `${templateDir}: ${errnoCode(err)}` };
  }
  if (dirStat.isSymbolicLink()) return { ok: false, error: `${templateDir}: template dir is a symlink` };
  if (!dirStat.isDirectory()) return { ok: false, error: `${templateDir}: template path is not a directory` };

  let entries: string[];
  try {
    entries = fs.readdirSync(templateDir);
  } catch (err) {
    return { ok: false, error: `${templateDir}: ${errnoCode(err)}` };
  }
  const allowed = new Set<string>(PI_AGENT_TEMPLATE_FILES);
  const ignored = entries.filter((name) => !allowed.has(name)).sort();

  // Validate every source before writing anything, so a bad template leaves
  // the agent dir as it was.
  const sources: Array<{ name: string; content: Buffer }> = [];
  const absent: string[] = [];
  for (const name of PI_AGENT_TEMPLATE_FILES) {
    const src = nodePath.join(templateDir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(src);
    } catch (err) {
      if (errnoCode(err) === "ENOENT") {
        absent.push(name);
        continue;
      }
      return { ok: false, error: `${src}: ${errnoCode(err)}` };
    }
    if (!st.isFile()) return { ok: false, error: `${src}: not a regular file` };
    let content: Buffer;
    try {
      content = fs.readFileSync(src);
    } catch (err) {
      return { ok: false, error: `${src}: ${errnoCode(err)}` };
    }
    try {
      JSON.parse(content.toString("utf-8"));
    } catch {
      return { ok: false, error: `${src}: invalid JSON` };
    }
    sources.push({ name, content });
  }

  const copied: string[] = [];
  for (const { name, content } of sources) {
    const dest = nodePath.join(agentDir, name);
    // Temp name + rename: a symlink planted at `dest` is replaced, never followed.
    const tmp = nodePath.join(agentDir, `.${name}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      fs.writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, dest);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
      return { ok: false, error: `${dest}: ${errnoCode(err)}` };
    }
    copied.push(name);
  }

  const removed: string[] = [];
  for (const name of absent) {
    const dest = nodePath.join(agentDir, name);
    try {
      fs.unlinkSync(dest);
      removed.push(name);
    } catch (err) {
      if (errnoCode(err) !== "ENOENT") return { ok: false, error: `${dest}: ${errnoCode(err)}` };
    }
  }

  return { ok: true, templatePresent: true, copied, removed, ignored };
}
