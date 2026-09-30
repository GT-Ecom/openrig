// The grok runtime adapter (`runtime: grok`): the grok TUI in the seat's tmux pane.
//
// Startup content is NEVER pasted into the pane (grok treats pasted text as untrusted input):
// guidance and send_text content (rig-role included) are merged as managed blocks into a per-seat
// standing-instructions file that reaches grok through `--rules` at launch; skills go to a per-seat
// skills dir. Nothing is written into the seat's cwd.
//
// The launch is ONE line from the shared launch wrapper (env, an optional `grok login` step, the
// `--rules` file read at launch). Readiness has two sources, because whether SessionStart fires when
// the TUI starts or only at the first prompt is not settled: a `session_start` hook event recorded
// after the launch's byte offset, or a live $GROK_HOME/active_sessions.json entry opened no earlier
// than 5 s before the launch.

import nodePath from "node:path";
import { randomUUID } from "node:crypto";
import type { TmuxAdapter } from "./tmux.js";
import { yoloEnabled } from "./yolo-mode.js";
import { buildWrappedLaunch } from "./launch-wrapper.js";
import {
  ensureGrokHookInstalled, readGrokSessionEvents, readGrokActiveSession, parseOpenedAt,
  grokMarkerPath, grokEventsPath, byteSize, isUuidShaped, type GrokFsOps,
} from "./grok-hooks.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  InstalledResource, ProjectionResult, StartupDeliveryResult, ReadinessResult,
  HarnessLaunchResult, ForkSource,
} from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { validateResumeToken } from "../domain/resume-token-validation.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";
import { MANAGED_BLOCK_END, MANAGED_BLOCK_START } from "../domain/managed-blocks.js";
import type { AppliedLaunchObservation } from "../domain/permission-drift.js";

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

/** `--rules` puts the file's contents into argv: Linux caps one argument at 128 KiB, and argv is
 *  readable by other users through `ps`, so never put a secret in the standing instructions. */
export const GROK_MAX_STANDING_INSTRUCTIONS_BYTES = 96 * 1024;

/** An active_sessions entry counts only when opened no earlier than this before the launch, so a
 *  stale entry whose pid was reused does not make a resume ready. */
const OPENED_AT_TOLERANCE_MS = 5000;

const POLL_MS = 250;
const POLL_ATTEMPTS = 60; // ~15 s
const GROK_SKILLS_BLOCK_ID = "openrig-grok-skills";

function withSkillsBlock(existing: string, skillsDir: string, enabled: boolean): string {
  const begin = MANAGED_BLOCK_START(GROK_SKILLS_BLOCK_ID);
  const end = MANAGED_BLOCK_END(GROK_SKILLS_BLOCK_ID);
  if (!enabled && !existing.includes(begin)) return existing;
  const escapedBegin = begin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const without = existing.replace(new RegExp(`(?:\\n|^)\\s*${escapedBegin}[\\s\\S]*?${escapedEnd}\\s*(?=\\n|$)`, "g"), "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!enabled) return without.length > 0 ? `${without}\n` : "";
  const content = `Skills for this seat are in ${skillsDir}. Each subdirectory holds a SKILL.md; read the one whose description matches your task before you start it.`;
  const block = `${begin}\n${content}\n${end}`;
  return without.length > 0 ? `${without}\n\n${block}\n` : `${block}\n`;
}

export interface GrokAdapterFsOps extends GrokFsOps {
  listFiles?(dirPath: string): string[];
}

export interface GrokRuntimeAdapterDeps {
  tmux: TmuxAdapter;
  fsOps: GrokAdapterFsOps;
  /** Seat state root, typically <OPENRIG_HOME>/state/grok. */
  stateRoot: string;
  /** The GROK_HOME the pane's grok uses and the hook is installed into. */
  grokHome: string;
  /** Optional external auth: exported as GROK_AUTH_PROVIDER_COMMAND, with `grok login` run first. */
  authProviderCommand?: string;
  /** Liveness of a pid. Default: `kill(pid, 0)` succeeds or throws EPERM (exists, other user). */
  isPidAlive?: (pid: number) => boolean;
  /** The kill function the default isPidAlive uses (tests inject). Default process.kill. */
  kill?: (pid: number, signal: 0) => unknown;
  sleep?: (ms: number) => Promise<void>;
  newSessionId?: () => string;
  now?: () => number;
}

interface SeatSession {
  sessionId: string;
  /** Events before this byte offset belong to an earlier run. */
  eventsBaselineBytes: number;
  launchedAtMs: number;
}

export function pidAliveVia(kill: (pid: number, signal: 0) => unknown): (pid: number) => boolean {
  return (pid) => {
    try {
      kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM: the process exists but belongs to another user. Only ESRCH (or anything else) is dead.
      return (err as NodeJS.ErrnoException)?.code === "EPERM";
    }
  };
}

export function grokSeatPaths(stateRoot: string, sessionName: string) {
  if (!sessionName || sessionName.includes("/") || sessionName === "." || sessionName === "..") {
    throw new Error("grok: the tmux session name cannot name a seat state dir");
  }
  const seatDir = nodePath.join(stateRoot, "seats", sessionName);
  return {
    seatDir,
    standingInstructions: nodePath.join(seatDir, "standing-instructions.md"),
    initialPrompt: nodePath.join(seatDir, "initial-prompt.md"),
    skillsDir: nodePath.join(seatDir, "skills"),
    sessionJson: nodePath.join(seatDir, "session.json"),
  };
}

export class GrokRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "grok";
  readonly startupTextDelivery = "launch";
  private tmux: TmuxAdapter;
  private fs: GrokAdapterFsOps;
  private stateRoot: string;
  private grokHome: string;
  private authProviderCommand: string | null;
  private isPidAlive: (pid: number) => boolean;
  private sleep: (ms: number) => Promise<void>;
  private newSessionId: () => string;
  private now: () => number;
  private sessions = new Map<string, SeatSession>();

  constructor(deps: GrokRuntimeAdapterDeps) {
    this.tmux = deps.tmux;
    this.fs = deps.fsOps;
    this.stateRoot = deps.stateRoot;
    this.grokHome = deps.grokHome;
    this.authProviderCommand = deps.authProviderCommand || null;
    this.isPidAlive = deps.isPidAlive ?? pidAliveVia(deps.kill ?? ((pid, signal) => process.kill(pid, signal)));
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.newSessionId = deps.newSessionId ?? (() => randomUUID());
    this.now = deps.now ?? (() => Date.now());
  }

  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const results: InstalledResource[] = [];
    if (!binding.tmuxSession) return results;
    const { skillsDir } = grokSeatPaths(this.stateRoot, binding.tmuxSession);
    if (this.fs.exists(skillsDir) && this.fs.listFiles) {
      for (const file of this.fs.listFiles(skillsDir)) {
        results.push({ effectiveId: file, category: "skill", installedPath: nodePath.join(skillsDir, file) });
      }
    }
    return results;
  }

  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    const projected: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ effectiveId: string; error: string }> = [];
    for (const entry of plan.entries) {
      if (entry.classification === "no_op") {
        skipped.push(entry.effectiveId);
        continue;
      }
      try {
        if (this.projectEntry(entry, binding)) projected.push(entry.effectiveId);
        else skipped.push(entry.effectiveId);
      } catch (err) {
        failed.push({ effectiveId: entry.effectiveId, error: (err as Error).message });
      }
    }
    return { projected, skipped, failed };
  }

  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult> {
    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];
    for (const file of files) {
      try {
        if (!binding.tmuxSession) throw new Error("No tmux session bound — cannot resolve the grok seat state dir");
        const paths = grokSeatPaths(this.stateRoot, binding.tmuxSession);
        const content = this.fs.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? resolveConcreteHint(file.path, content) : file.deliveryHint;
        switch (hint) {
          case "guidance_merge":
          case "send_text":
            // Never pasted: both land in the per-seat standing-instructions file (read via --rules).
            // The file is per seat, so rig-role cannot collide with a pod-mate's here.
            mergeManagedBlock(this.fs, paths.standingInstructions, file.path, content);
            break;
          case "skill_install": {
            const targetDir = nodePath.join(paths.skillsDir, nodePath.basename(nodePath.dirname(file.absolutePath)));
            this.fs.mkdirp(targetDir);
            this.fs.writeFile(nodePath.join(targetDir, nodePath.basename(file.path)), content);
            break;
          }
        }
        delivered++;
      } catch (err) {
        if (file.required) failed.push({ path: file.path, error: (err as Error).message });
      }
    }
    return { delivered, failed };
  }

  async launchHarness(
    binding: NodeBinding,
    opts: { name: string; resumeToken?: string; forkSource?: ForkSource; initialPrompt?: string },
  ): Promise<HarnessLaunchResult> {
    if (!binding.tmuxSession) {
      return { ok: false, error: "No tmux session bound — cannot launch the grok harness" };
    }
    if (opts.resumeToken && opts.forkSource) {
      return { ok: false, error: "resumeToken and forkSource are mutually exclusive — pick one" };
    }
    if (!nodePath.isAbsolute(this.grokHome)) {
      return { ok: false, error: `grok launch: GROK_HOME must be absolute; received "${this.grokHome}"` };
    }
    if (opts.initialPrompt?.startsWith("-")) {
      return { ok: false, error: "grok launch: the initial prompt must not start with '-' because it is a positional argument" };
    }
    const promptBytes = opts.initialPrompt === undefined ? 0 : Buffer.byteLength(opts.initialPrompt, "utf8");
    if (promptBytes > GROK_MAX_STANDING_INSTRUCTIONS_BYTES) {
      return { ok: false, error: `grok launch: the initial prompt is ${promptBytes} bytes, over the ${GROK_MAX_STANDING_INSTRUCTIONS_BYTES}-byte limit` };
    }
    let resumeId: string | undefined;
    if (opts.resumeToken) {
      const validation = validateResumeToken("grok", opts.resumeToken);
      if (!validation.ok) return { ok: false, error: `grok resume: ${validation.error}` };
      resumeId = validation.token;
    }
    let parentId: string | undefined;
    if (opts.forkSource) {
      if (opts.forkSource.kind !== "native_id") {
        return {
          ok: false,
          error: `grok fork: ref.kind="${opts.forkSource.kind}" is not supported in v1; use ref.kind="native_id" with the parent grok session id`,
        };
      }
      const validation = validateResumeToken("grok", opts.forkSource.value);
      if (!validation.ok) return { ok: false, error: `grok fork: ${validation.error}` };
      parentId = validation.token;
    }

    const sessionName = binding.tmuxSession;
    let paths: ReturnType<typeof grokSeatPaths>;
    try {
      paths = grokSeatPaths(this.stateRoot, sessionName);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }

    let existingRules = "";
    if (this.fs.exists(paths.standingInstructions)) {
      try { existingRules = this.fs.readFile(paths.standingInstructions); } catch (err) {
        return { ok: false, error: `grok launch: cannot read the standing-instructions file: ${(err as Error).message}` };
      }
    }
    const hasSkills = !!this.fs.listFiles && this.fs.exists(paths.skillsDir) && this.fs.listFiles(paths.skillsDir).some((entry) => entry === "SKILL.md" || entry.endsWith("/SKILL.md"));
    const nextRules = withSkillsBlock(existingRules, paths.skillsDir, hasSkills);
    const rulesSize = Buffer.byteLength(nextRules, "utf8");
    if (rulesSize > GROK_MAX_STANDING_INSTRUCTIONS_BYTES) {
      return {
        ok: false,
        error: `grok launch: the standing-instructions file ${paths.standingInstructions} is ${rulesSize} bytes, over the ${GROK_MAX_STANDING_INSTRUCTIONS_BYTES}-byte limit (its contents are passed as one --rules argument)`,
      };
    }
    const hasRules = nextRules.length > 0;

    const sessionId = resumeId ?? this.newSessionId();
    if (!isUuidShaped(sessionId)) {
      return { ok: false, error: "grok launch: the new session id is not a UUID" };
    }

    const marker = grokMarkerPath(this.stateRoot, sessionId);
    const seat: SeatSession = {
      sessionId,
      eventsBaselineBytes: byteSize(this.fs, grokEventsPath(this.stateRoot, sessionId)),
      launchedAtMs: this.now(),
    };

    const argv = resumeId
      ? ["grok", "--resume", resumeId]
      : parentId
        ? ["grok", "--resume", parentId, "--fork-session", "--session-id", sessionId]
        : ["grok", "--session-id", sessionId];
    // The same floor/bypass decision Claude gets (global YOLO or the seat's resolved posture).
    const fullBypass = yoloEnabled(process.env, binding.launchPosture);
    argv.push("--permission-mode", fullBypass ? "bypassPermissions" : "acceptEdits");
    // grok's hook guide lists only default/auto/plan/bypassPermissions as emitted modes, and says
    // acceptEdits "has no grok equivalent": the floor stays unverified until a live check reads the
    // mode off the hook line.
    const appliedLaunch: AppliedLaunchObservation = fullBypass
      ? { runtime: "grok", axis: "permission", state: "observed", value: "bypassPermissions" }
      : { runtime: "grok", axis: "permission", state: "unknown", value: null, reason: "unverified_mode_mapping" };
    const model = binding.model?.trim();
    if (model) argv.push("-m", model);

    const env: Record<string, string> = { GROK_HOME: this.grokHome };
    if (this.authProviderCommand) env.GROK_AUTH_PROVIDER_COMMAND = this.authProviderCommand;
    let line: string;
    try {
      line = buildWrappedLaunch({
        argv,
        env,
        ...(this.authProviderCommand ? { before: [["grok", "login"]] } : {}),
        ...(hasRules ? { argFiles: [{ flag: "--rules", path: paths.standingInstructions }] } : {}),
        ...(opts.initialPrompt !== undefined ? { promptFile: paths.initialPrompt } : {}),
      });
    } catch (err) {
      return { ok: false, error: `grok launch: ${(err as Error).message}` };
    }

    // All refusals above are side-effect free. Commit launch state only after
    // the complete launch has been validated.
    if (nextRules !== existingRules || (hasRules && !this.fs.exists(paths.standingInstructions))) {
      this.fs.mkdirp(paths.seatDir);
      this.fs.writeFile(paths.standingInstructions, nextRules);
    }
    this.fs.mkdirp(paths.seatDir);
    this.fs.writeFile(paths.initialPrompt, opts.initialPrompt ?? "");
    ensureGrokHookInstalled(this.fs, this.grokHome, this.stateRoot);
    this.fs.mkdirp(nodePath.dirname(marker));
    this.fs.writeFile(marker, "");
    this.fs.writeFile(paths.sessionJson, JSON.stringify(seat));
    this.sessions.set(sessionName, seat);

    const textResult = await this.tmux.sendText(sessionName, line);
    if (!textResult.ok) return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
    const enterResult = await this.tmux.sendKeys(sessionName, ["Enter"]);
    if (!enterResult.ok) return { ok: false, error: `Failed to send Enter: ${enterResult.message}` };

    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      const state = this.sessionState(seat);
      if (state === "ready") return { ok: true, resumeToken: sessionId, resumeType: "grok_id", appliedLaunch };
      if (state === "ended") break;
      if (attempt < POLL_ATTEMPTS - 1) await this.sleep(POLL_MS);
    }
    const paneContent = (await this.tmux.capturePaneContent(sessionName, 40)) ?? "";
    return {
      ok: false,
      error: "grok launch: the session did not report ready (no session_start hook event and no live active session entry)",
      recovery: "attention_required",
      evidence: paneContent.split("\n").slice(-12).join("\n"),
    };
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    if (!binding.tmuxSession) return { ready: false, reason: "No tmux session bound" };
    if (!(await this.tmux.hasSession(binding.tmuxSession))) {
      return { ready: false, reason: "tmux session not responsive" };
    }
    const paneCommand = (await this.tmux.getPaneCommand(binding.tmuxSession)) ?? "";
    if (SHELL_COMMANDS.has(paneCommand)) {
      return { ready: false, reason: "the pane is back at a shell (grok is not running)", code: "runner_exited" };
    }
    const seat = this.seatSession(binding.tmuxSession);
    if (!seat) return { ready: false, reason: "no grok session has been launched for this seat", code: "awaiting_runtime" };
    const state = this.sessionState(seat);
    if (state === "ended") {
      return { ready: false, reason: "grok reported session_end after the latest session_start", code: "runner_exited" };
    }
    if (state === "ready") return { ready: true };
    return { ready: false, reason: "grok has not reported the session yet", code: "awaiting_runtime" };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** READY / ended / pending for one launch, from events after its byte offset and the
   *  active_sessions entry. A session_end after the latest session_start overrides READY. */
  private sessionState(seat: SeatSession): "ready" | "ended" | "pending" {
    const events = readGrokSessionEvents(this.fs, this.stateRoot, seat.sessionId, seat.eventsBaselineBytes);
    let lastStart = -1;
    let lastEnd = -1;
    events.forEach((e, i) => {
      if (e.event === "session_start") lastStart = i;
      else if (e.event === "session_end") lastEnd = i;
    });
    if (lastStart >= 0 && lastEnd > lastStart) return "ended";
    if (lastStart >= 0) return "ready";
    const entry = readGrokActiveSession(this.fs, this.grokHome, seat.sessionId);
    if (entry) {
      const openedAt = parseOpenedAt(entry.opened_at);
      if (openedAt !== null && openedAt >= seat.launchedAtMs - OPENED_AT_TOLERANCE_MS && this.isPidAlive(entry.pid)) {
        return "ready";
      }
    }
    return "pending";
  }

  private seatSession(sessionName: string): SeatSession | null {
    const cached = this.sessions.get(sessionName);
    if (cached) return cached;
    let path: string;
    try {
      path = grokSeatPaths(this.stateRoot, sessionName).sessionJson;
    } catch {
      return null;
    }
    try {
      if (!this.fs.exists(path)) return null;
      const parsed = JSON.parse(this.fs.readFile(path)) as Partial<SeatSession>;
      if (
        typeof parsed.sessionId !== "string" || !isUuidShaped(parsed.sessionId)
        || typeof parsed.eventsBaselineBytes !== "number" || typeof parsed.launchedAtMs !== "number"
      ) return null;
      const seat = { sessionId: parsed.sessionId, eventsBaselineBytes: parsed.eventsBaselineBytes, launchedAtMs: parsed.launchedAtMs };
      this.sessions.set(sessionName, seat);
      return seat;
    } catch {
      return null;
    }
  }

  private projectEntry(entry: ProjectionEntry, binding: NodeBinding): boolean {
    if (!binding.tmuxSession) return false;
    const paths = grokSeatPaths(this.stateRoot, binding.tmuxSession);
    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      mergeManagedBlock(this.fs, paths.standingInstructions, entry.effectiveId, this.fs.readFile(entry.absolutePath));
      return true;
    }
    if (entry.category === "skill") {
      const targetDir = nodePath.join(paths.skillsDir, entry.effectiveId);
      this.fs.mkdirp(targetDir);
      const children = this.fs.listFiles ? this.fs.listFiles(entry.absolutePath) : [];
      if (children.length > 0) {
        for (const file of children) {
          const dest = nodePath.join(targetDir, file);
          this.fs.mkdirp(nodePath.dirname(dest));
          this.fs.writeFile(dest, this.fs.readFile(nodePath.join(entry.absolutePath, file)));
        }
      } else {
        this.fs.writeFile(nodePath.join(targetDir, nodePath.basename(entry.absolutePath)), this.fs.readFile(entry.absolutePath));
      }
      return true;
    }
    // Plugins / subagents / runtime resources have no grok projection target yet: an honest skip.
    return false;
  }
}
