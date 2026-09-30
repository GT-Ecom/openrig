import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { buildWrappedLaunch } from "../src/adapters/launch-wrapper.js";

const dirs: string[] = [];
const temp = () => { const d = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-wrapper-hardening-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe("launch wrapper hardening", () => {
  it("execs the harness as the wrapper foreground process", async () => {
    const dir = temp();
    const harness = nodePath.join(dir, "harness");
    fs.writeFileSync(harness, "#!/bin/sh\necho $$\n", { mode: 0o755 });
    const child = spawn("/bin/sh", ["-c", `exec ${buildWrappedLaunch({ argv: [harness] })}`], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(status).toBe(0);
    // On shells that implicitly exec their last command, the mutant and fixed forms coincide.
    expect(Number(stdout.trim())).toBe(child.pid);
  });

  it("keeps wrapper stdin away from before steps", () => {
    const dir = temp();
    const out = nodePath.join(dir, "out");
    const line = buildWrappedLaunch({ argv: ["sh", "-c", ":"], env: { OUT: out }, before: [["sh", "-c", 'cat >"$OUT"']] });
    const wrapped = spawnSync("/bin/sh", ["-c", line], { input: "LEAK\n", encoding: "utf8" });
    expect(wrapped.status).toBe(0);
    expect(fs.readFileSync(out, "utf8")).toBe("");
    spawnSync("/bin/sh", ["-c", 'cat >"$OUT"'], { env: { OUT: out }, input: "LEAK\n", encoding: "utf8" });
    expect(fs.readFileSync(out, "utf8")).toBe("LEAK\n");
  });

  it("appends a hostile prompt file as one final argument", () => {
    const dir = temp();
    const promptFile = nodePath.join(dir, "prompt file");
    const out = nodePath.join(dir, "argv");
    const prompt = " leading '$;\n$(touch x) `touch x`";
    fs.writeFileSync(promptFile, prompt);
    const line = buildWrappedLaunch({ argv: ["sh", "-c", 'printf "%s\\0" "$@" >"$OUT"', "harness", "base"], env: { OUT: out }, argFiles: [{ flag: "--rules", path: promptFile }], promptFile });
    expect(line).not.toContain(prompt);
    expect(line).not.toContain("\n");
    const result = spawnSync("/bin/sh", ["-c", line], { cwd: dir, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(fs.readFileSync(out).toString().split("\0").slice(0, -1)).toEqual(["base", "--rules", prompt, prompt]);
    expect(fs.existsSync(nodePath.join(dir, "x"))).toBe(false);
  });

  it("rejects relative and missing prompt files", () => {
    expect(() => buildWrappedLaunch({ argv: ["true"], promptFile: "prompt.md" })).toThrow(/absolute/);
    const line = buildWrappedLaunch({ argv: ["sh", "-c", 'touch "$OUT"'], env: { OUT: nodePath.join(temp(), "ran") }, promptFile: "/missing/prompt.md" });
    const result = spawnSync("/bin/sh", ["-c", line], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/prompt file/);
  });
});
