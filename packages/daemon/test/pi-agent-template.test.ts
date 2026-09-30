// Pi agent-dir seeding from an operator template: real temp dirs, no root, no
// network, no real `pi`. Every case carries a control that can fail.

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  seedPiAgentDir, PI_AGENT_TEMPLATE_DIRNAME, PI_AGENT_TEMPLATE_FILES,
} from "../src/adapters/pi-agent-template.js";

const SENTINEL = "sk-sentinel-DO-NOT-LEAK-7f3a";

let root: string;
let templateDir: string;
let agentDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-pi-template-"));
  templateDir = nodePath.join(root, PI_AGENT_TEMPLATE_DIRNAME);
  agentDir = nodePath.join(root, "state", "agent");
  fs.mkdirSync(templateDir);
  fs.mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeTemplate(name: string, value: unknown): void {
  fs.writeFileSync(nodePath.join(templateDir, name), JSON.stringify(value));
}

function mode(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

describe("seedPiAgentDir", () => {
  it("exports the convention dirname and the allowlist", () => {
    expect(PI_AGENT_TEMPLATE_DIRNAME).toBe("pi-agent-template");
    expect([...PI_AGENT_TEMPLATE_FILES]).toEqual(["auth.json", "settings.json", "models.json"]);
  });

  it("copies the three allowlisted files with mode 0600 and ignores (but names) everything else", () => {
    writeTemplate("auth.json", { openrouter: { type: "api_key", key: "!cat /run/key" } });
    writeTemplate("settings.json", { defaultProvider: "openrouter" });
    writeTemplate("models.json", { providers: {} });
    fs.writeFileSync(nodePath.join(templateDir, "SYSTEM.md"), "override the prompt");
    fs.writeFileSync(nodePath.join(templateDir, "AGENTS.md"), "more prompt");

    const result = seedPiAgentDir(templateDir, agentDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.copied].sort()).toEqual(["auth.json", "models.json", "settings.json"]);
    for (const name of PI_AGENT_TEMPLATE_FILES) {
      const dest = nodePath.join(agentDir, name);
      expect(fs.readFileSync(dest, "utf-8")).toBe(fs.readFileSync(nodePath.join(templateDir, name), "utf-8"));
      expect(mode(dest)).toBe(0o600);
    }
    // Control: the non-allowlisted entries are named and NOT copied.
    expect([...result.ignored].sort()).toEqual(["AGENTS.md", "SYSTEM.md"]);
    expect(fs.existsSync(nodePath.join(agentDir, "SYSTEM.md"))).toBe(false);
    expect(fs.existsSync(nodePath.join(agentDir, "AGENTS.md"))).toBe(false);
    // No temp files left behind.
    expect(fs.readdirSync(agentDir).sort()).toEqual(["auth.json", "models.json", "settings.json"]);
  });

  it("refuses a symlinked source file and writes nothing", () => {
    writeTemplate("settings.json", { a: 1 });
    const real = nodePath.join(root, "real-auth.json");
    fs.writeFileSync(real, JSON.stringify({ k: SENTINEL }));
    fs.symlinkSync(real, nodePath.join(templateDir, "auth.json"));

    const result = seedPiAgentDir(templateDir, agentDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("auth.json");
      expect(result.error).not.toContain(SENTINEL);
    }
    expect(fs.readdirSync(agentDir)).toEqual([]);

    // Control: the same content as a regular file seeds.
    fs.unlinkSync(nodePath.join(templateDir, "auth.json"));
    fs.copyFileSync(real, nodePath.join(templateDir, "auth.json"));
    const again = seedPiAgentDir(templateDir, agentDir);
    expect(again.ok).toBe(true);
    expect(fs.readFileSync(nodePath.join(agentDir, "auth.json"), "utf-8")).toContain(SENTINEL);
  });

  it("refuses a directory in place of an allowlisted file", () => {
    fs.mkdirSync(nodePath.join(templateDir, "models.json"));
    const result = seedPiAgentDir(templateDir, agentDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("models.json");
  });

  it("invalid JSON is an error naming the file, never its content", () => {
    const src = nodePath.join(templateDir, "auth.json");
    fs.writeFileSync(src, `{ "openrouter": "${SENTINEL}" `);
    // Control: the probe can see the sentinel in the file.
    expect(fs.readFileSync(src, "utf-8")).toContain(SENTINEL);

    const result = seedPiAgentDir(templateDir, agentDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("auth.json");
    expect(result.error).toContain("invalid JSON");
    expect(result.error).not.toContain(SENTINEL);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(fs.readdirSync(agentDir)).toEqual([]);
  });

  it("replaces a symlink planted at the destination without following it", () => {
    writeTemplate("auth.json", { k: "new" });
    const victim = nodePath.join(root, "victim.txt");
    const victimBytes = Buffer.from("victim content\n");
    fs.writeFileSync(victim, victimBytes);
    const dest = nodePath.join(agentDir, "auth.json");
    fs.symlinkSync(victim, dest);

    const result = seedPiAgentDir(templateDir, agentDir);
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(victim).equals(victimBytes)).toBe(true);
    // Control: the destination is now a regular file with the template's bytes.
    const st = fs.lstatSync(dest);
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isFile()).toBe(true);
    expect(JSON.parse(fs.readFileSync(dest, "utf-8"))).toEqual({ k: "new" });
  });

  it("a second seed after the template changed overwrites the first", () => {
    writeTemplate("settings.json", { v: 1 });
    expect(seedPiAgentDir(templateDir, agentDir).ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(nodePath.join(agentDir, "settings.json"), "utf-8"))).toEqual({ v: 1 });

    writeTemplate("settings.json", { v: 2 });
    expect(seedPiAgentDir(templateDir, agentDir).ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(nodePath.join(agentDir, "settings.json"), "utf-8"))).toEqual({ v: 2 });
  });

  it("removes a file an earlier seed left once the template no longer holds it", () => {
    writeTemplate("models.json", { providers: {} });
    writeTemplate("settings.json", { v: 1 });
    expect(seedPiAgentDir(templateDir, agentDir).ok).toBe(true);
    expect(fs.existsSync(nodePath.join(agentDir, "models.json"))).toBe(true);

    fs.unlinkSync(nodePath.join(templateDir, "models.json"));
    const result = seedPiAgentDir(templateDir, agentDir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.removed).toEqual(["models.json"]);
    expect(fs.existsSync(nodePath.join(agentDir, "models.json"))).toBe(false);
    expect(fs.existsSync(nodePath.join(agentDir, "settings.json"))).toBe(true);
  });

  it("control: with no template dir at all, the agent dir is left exactly as it is", () => {
    fs.writeFileSync(nodePath.join(agentDir, "models.json"), "{}");
    fs.rmSync(templateDir, { recursive: true });
    const result = seedPiAgentDir(templateDir, agentDir);
    expect(result).toEqual({ ok: true, templatePresent: false, copied: [], removed: [], ignored: [] });
    expect(fs.readdirSync(agentDir)).toEqual(["models.json"]);
  });

  it("refuses a symlinked template dir", () => {
    writeTemplate("settings.json", { v: 1 });
    const link = nodePath.join(root, "linked-template");
    fs.symlinkSync(templateDir, link);

    const result = seedPiAgentDir(link, agentDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(link);
    expect(fs.readdirSync(agentDir)).toEqual([]);

    // Control: the real dir seeds.
    expect(seedPiAgentDir(templateDir, agentDir).ok).toBe(true);
  });
});
