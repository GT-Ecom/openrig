// The credential-fd launch wrapper: a single typed line that opens a credential FILE onto a
// numbered fd for the harness it execs. Every case runs the built line through a real `sh`
// against a stand-in harness in a temp dir (no tmux here; the tmux leg is launch-wrapper-tmux).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { spawnSync } from "node:child_process";
import { buildWrappedLaunch } from "../src/adapters/launch-wrapper.js";

const TOKEN = "tok-SECRET-9f3a1c";
let dir: string;
let bin: string;
let tokenPath: string;

function run(line: string, cwd: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("/bin/sh", ["-c", line], {
    cwd,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir },
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeAll(() => {
  dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-launch-wrapper-"));
  bin = nodePath.join(dir, "bin");
  fs.mkdirSync(bin);
  tokenPath = nodePath.join(dir, "cred dir 'x'", "token");
  fs.mkdirSync(nodePath.dirname(tokenPath));
  fs.writeFileSync(tokenPath, TOKEN);
  // Stand-in harness: reports fd 3, selected env, and each argv element on its own record.
  fs.writeFileSync(
    nodePath.join(bin, "harness"),
    [
      "#!/bin/sh",
      'out="$HARNESS_OUT"',
      'if (: <&3) 2>/dev/null; then printf "FD3=%s\\n" "$(cat <&3)" >"$out"; else echo "FD3=none" >"$out"; fi',
      'printf "ENV=%s|\\n" "$WEIRD" >>"$out"',
      'for a in "$@"; do printf "ARG=%s|\\n" "$a" >>"$out"; done',
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
  // Stand-in pre-launch step: records that it ran and whether it saw fd 3.
  fs.writeFileSync(
    nodePath.join(bin, "prestep"),
    [
      "#!/bin/sh",
      'if (: <&3) 2>/dev/null; then echo "BEFORE fd3=yes arg=$1 env=$WEIRD" >>"$HARNESS_OUT"; else echo "BEFORE fd3=no arg=$1 env=$WEIRD" >>"$HARNESS_OUT"; fi',
      'exit "${PRESTEP_EXIT:-0}"',
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("buildWrappedLaunch", () => {
  it("round-trips hostile paths, env values and argv through sh; x is never created", () => {
    const cwd = fs.mkdtempSync(nodePath.join(dir, "cwd-"));
    const out = nodePath.join(cwd, "out 'q' $x.txt");
    const hostile = ["it's", "$HOME", "a;b", "sp ace", "new\nline", "$(touch x)", "back`touch x`tick", "-leading"];
    const argFile = nodePath.join(cwd, "rules $(touch x).txt");
    fs.writeFileSync(argFile, "rule one\nrule 'two' $(touch x)");
    const line = buildWrappedLaunch({
      argv: ["harness", ...hostile],
      env: { HARNESS_OUT: out, WEIRD: "v'$(touch x)`touch x`;\nz" },
      fds: [{ fd: 3, path: tokenPath }],
      argFiles: [{ flag: "--rules", path: argFile }],
    });
    const r = run(line, cwd);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const text = fs.readFileSync(out, "utf8");
    expect(text).toBe(
      [
        `FD3=${TOKEN}`,
        "ENV=v'$(touch x)`touch x`;\nz|",
        ...hostile.map((a) => `ARG=${a}|`),
        "ARG=--rules|",
        "ARG=rule one\nrule 'two' $(touch x)|",
      ].join("\n") + "\n",
    );
    expect(fs.existsSync(nodePath.join(cwd, "x"))).toBe(false);
  });

  it("runs each before step first, with env but WITHOUT the credential fd", () => {
    const cwd = fs.mkdtempSync(nodePath.join(dir, "cwd-"));
    const out = nodePath.join(cwd, "out.txt");
    const line = buildWrappedLaunch({
      argv: ["harness", "final"],
      env: { HARNESS_OUT: out, WEIRD: "w" },
      fds: [{ fd: 3, path: tokenPath }],
      before: [["prestep", "first $(touch x)"], ["prestep", "second"]],
    });
    const r = run(line, cwd);
    expect(r.status).toBe(0);
    const lines = fs.readFileSync(out, "utf8").split("\n");
    // The harness truncates the file, so read the before steps' lines via a second probe below.
    expect(lines[0]).toBe(`FD3=${TOKEN}`);

    const log = nodePath.join(cwd, "before.log");
    const line2 = buildWrappedLaunch({
      argv: ["sh", "-c", 'cat "$LOG" >"$HARNESS_OUT.all"; echo HARNESS >>"$HARNESS_OUT.all"'],
      env: { HARNESS_OUT: log, LOG: log, WEIRD: "w" },
      fds: [{ fd: 3, path: tokenPath }],
      before: [["prestep", "first $(touch x)"], ["prestep", "second"]],
    });
    expect(run(line2, cwd).status).toBe(0);
    expect(fs.readFileSync(`${log}.all`, "utf8")).toBe(
      "BEFORE fd3=no arg=first $(touch x) env=w\nBEFORE fd3=no arg=second env=w\nHARNESS\n",
    );
    expect(fs.existsSync(nodePath.join(cwd, "x"))).toBe(false);
  });

  it("builds one line with no newline that never contains the token contents", () => {
    const line = buildWrappedLaunch({
      argv: ["harness", "multi\nline"],
      env: { A: "b\nc" },
      fds: [{ fd: 3, path: tokenPath }, { fd: 9, path: tokenPath + "2" }],
      before: [["prestep"]],
      argFiles: [{ flag: "--rules", path: "/r.txt" }],
    });
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\r");
    expect(line).not.toContain(TOKEN);
    expect(line.startsWith("/bin/sh -c '")).toBe(true);
    expect(line).toContain("' openrig-launch ");
  });

  it("throws on invalid input", () => {
    const ok = { argv: ["harness"] };
    expect(() => buildWrappedLaunch({ ...ok, fds: [{ fd: 2, path: "/t" }] })).toThrow(/fd/);
    expect(() => buildWrappedLaunch({ ...ok, fds: [{ fd: 10, path: "/t" }] })).toThrow(/fd/);
    expect(() => buildWrappedLaunch({ ...ok, fds: [{ fd: 3, path: "/a" }, { fd: 3, path: "/b" }] })).toThrow(/duplicate/);
    expect(() => buildWrappedLaunch({ ...ok, fds: [{ fd: 3, path: "rel/token" }] })).toThrow(/absolute/);
    expect(() => buildWrappedLaunch({ ...ok, argFiles: [{ flag: "--rules", path: "rel.md" }] })).toThrow(/absolute/);
    expect(() => buildWrappedLaunch({ ...ok, env: { "bad-name": "x" } })).toThrow(/env/);
    expect(() => buildWrappedLaunch({ argv: [] })).toThrow(/argv/);
    expect(() => buildWrappedLaunch({ argv: ["A=B"] })).toThrow(/argv\[0\]/);
    expect(() => buildWrappedLaunch({ argv: ["-x"] })).toThrow(/argv\[0\]/);
  });

  it("control: a failing before step stops the harness", () => {
    const cwd = fs.mkdtempSync(nodePath.join(dir, "cwd-"));
    const out = nodePath.join(cwd, "out.txt");
    const line = buildWrappedLaunch({
      argv: ["sh", "-c", 'echo HARNESS >>"$HARNESS_OUT"'],
      env: { HARNESS_OUT: out, PRESTEP_EXIT: "1" },
      before: [["prestep", "a"]],
    });
    const r = run(line, cwd);
    expect(r.status).not.toBe(0);
    expect(fs.readFileSync(out, "utf8")).not.toContain("HARNESS");
  });

  it("control: a missing credential file exits non-zero naming the fd; the harness never runs", () => {
    const cwd = fs.mkdtempSync(nodePath.join(dir, "cwd-"));
    const out = nodePath.join(cwd, "out.txt");
    const line = buildWrappedLaunch({
      argv: ["sh", "-c", 'echo HARNESS >"$HARNESS_OUT"'],
      env: { HARNESS_OUT: out },
      fds: [{ fd: 4, path: nodePath.join(dir, "no-such-token") }],
    });
    const r = run(line, cwd);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/fd 4/);
    expect(fs.existsSync(out)).toBe(false);
  });
});
