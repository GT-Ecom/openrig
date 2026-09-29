// `runtime: grok` registration: admitted by the pod preflight runtime gate (with a `grok --version`
// probe), resolvable as the grok_id resume type, registered in the production runtimeAdapters
// registry, and dispatched by the assembled pod instantiator. An unknown runtime is still refused.

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rigPreflight } from "../src/domain/rigspec-preflight.js";
import { resumeTypeForRuntime, validateResumeToken } from "../src/domain/resume-token-validation.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import { createDaemon } from "../src/startup.js";
import type { CmuxTransportFactory } from "../src/adapters/cmux.js";
import type { ExecFn } from "../src/adapters/tmux.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { DEFAULT_SYSTEM_WORLD_MANIFEST } from "../src/domain/system-world.js";
import { GrokRuntimeAdapter } from "../src/adapters/grok-runtime-adapter.js";

const AGENT_YAML = `name: impl
version: "1.0.0"
resources:
  skills: []
profiles:
  default:
    uses:
      skills: []`;

const agentFs = (): AgentResolverFsOps => ({
  exists: (p) => p.includes("agents/impl"),
  readFile: (p) => {
    if (p.includes("agents/impl")) return AGENT_YAML;
    throw new Error(`not found: ${p}`);
  },
});

const rigYaml = (runtime: string) => `version: "0.2"
name: grok-rig
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        runtime: ${runtime}
        agent_ref: local:agents/impl
        profile: default
        cwd: .
    edges: []
`;

describe("preflight admits runtime: grok", () => {
  it("passes when the exec stub answers grok --version", async () => {
    const calls: string[] = [];
    const result = await rigPreflight({
      rigSpecYaml: rigYaml("grok"),
      rigRoot: "/probe/root",
      fsOps: agentFs(),
      exec: async (cmd) => { calls.push(cmd); return "grok 1.0.41\n"; },
    });
    expect(result.errors).toEqual([]);
    expect(result.ready).toBe(true);
    expect(calls).toContain("grok --version");
  });

  it("fails with an error naming grok when grok --version throws", async () => {
    const result = await rigPreflight({
      rigSpecYaml: rigYaml("grok"),
      rigRoot: "/probe/root",
      fsOps: agentFs(),
      exec: async (cmd) => {
        if (cmd.startsWith("grok")) throw new Error("grok: not found");
        return "";
      },
    });
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("grok"))).toBe(true);
  });

  it("control: runtime grok-nonexistent is refused upstream with unsupported runtime", async () => {
    const result = await rigPreflight({
      rigSpecYaml: rigYaml("grok-nonexistent"),
      rigRoot: "/probe/root",
      fsOps: agentFs(),
      exec: async () => "",
    });
    expect(result.ready).toBe(false);
    expect(result.errors).toContain('dev.impl: unsupported runtime "grok-nonexistent"');
  });
});

describe("grok resume type", () => {
  it("resumeTypeForRuntime(grok) is grok_id; only UUID-shaped ids validate, never echoed", () => {
    expect(resumeTypeForRuntime("grok")).toBe("grok_id");
    const ok = validateResumeToken("grok", " 0b7c6a52-3f1e-4d2a-9c8b-1a2b3c4d5e6f ");
    expect(ok).toEqual({ ok: true, resumeType: "grok_id", token: "0b7c6a52-3f1e-4d2a-9c8b-1a2b3c4d5e6f" });
    for (const bad of ["my-session-title", "0b7c6a52-3f1e-4d2a-9c8b", "0b7c6a52/3f1e"]) {
      const r = validateResumeToken("grok", bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).not.toContain(bad);
    }
  });
});

describe("createDaemon registers and dispatches the grok adapter", () => {
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

  it("exposes deps.runtimeAdapters.grok", async () => {
    const { db, deps } = await createDaemon({ cmuxFactory, tmuxExec });
    try {
      expect(deps.runtimeAdapters!["grok"]).toBeInstanceOf(GrokRuntimeAdapter);
      expect(deps.runtimeAdapters!["grok"]!.runtime).toBe("grok");
    } finally {
      db.close();
    }
  }, 30000);

  it("dispatches a runtime: grok seat to the grok adapter's project()", async () => {
    const rigRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-grok-dispatch-"));
    fs.mkdirSync(path.join(rigRoot, "agents", "impl"), { recursive: true });
    fs.writeFileSync(path.join(rigRoot, "agents", "impl", "agent.yaml"), AGENT_YAML);
    const worldPath = path.join(rigRoot, "world.yaml");
    fs.writeFileSync(worldPath, DEFAULT_SYSTEM_WORLD_MANIFEST);
    const savedWorld = process.env.OPENRIG_CONTEXT_SYSTEM_WORLD;
    process.env.OPENRIG_CONTEXT_SYSTEM_WORLD = worldPath;
    let db: { close(): void } | undefined;
    try {
      const daemon = await createDaemon({ cmuxFactory, tmuxExec });
      db = daemon.db;
      const adapters = (daemon.deps.podInstantiator as unknown as { deps: { adapters: Record<string, RuntimeAdapter> } }).deps.adapters;
      const grok = adapters["grok"];
      expect(grok, "the production instantiator adapters map must register grok").toBeDefined();
      const projectSpy = vi.spyOn(grok!, "project");
      // Dispatch is the claim here; the launch itself (which would poll for readiness against the
      // stub tmux) is covered by grok-runtime-adapter.test.ts.
      vi.spyOn(grok!, "launchHarness").mockResolvedValue({ ok: false, error: "launch not exercised in the dispatch test" });
      const specYaml = RigSpecCodec.serialize({
        version: "0.2",
        name: "grok-dispatch-rig",
        pods: [{
          id: "dev",
          label: "Dev",
          members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "grok", cwd: "." }],
          edges: [],
        }],
        edges: [],
      });
      const result = await daemon.deps.podInstantiator.instantiate(specYaml, rigRoot);
      expect(projectSpy, `instantiate must dispatch project() to the grok adapter: ${JSON.stringify(result)}`).toHaveBeenCalled();
    } finally {
      if (savedWorld === undefined) delete process.env.OPENRIG_CONTEXT_SYSTEM_WORLD;
      else process.env.OPENRIG_CONTEXT_SYSTEM_WORLD = savedWorld;
      db?.close();
      fs.rmSync(rigRoot, { recursive: true, force: true });
    }
  }, 30000);
});
