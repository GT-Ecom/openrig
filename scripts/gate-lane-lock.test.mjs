import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireGateLane, GATE_LANE_PORT } from "./gate-lane-lock.mjs";

// F1 gate-lane (arch d6a6c1db; mechanism (B) bound-localhost-port, desk-concurred): a machine-wide
// kernel-released-on-death mutex. Acquire NON-BLOCKING; gate-vs-gate contention HARD-REFUSES naming the
// holder (pid/started-at); a FOREIGN process on the port with NO holder-info file is FAIL-CLOSED
// ("foreign-holder", load-115). flock(2) is anonymous → a holder-info file is needed under any mechanism.
//
// PORT HYGIENE: every test binds port 0 and reuses the port the kernel handed back. Fixed ports
// (45871–45876 until 2026-09-30) sit inside Linux's ephemeral range and are machine-wide, so two gates
// running this suite at once (or any process that drew one of them) failed "release frees the lane".
const info = () => join(mkdtempSync(join(tmpdir(), "gl-")), "holder.json");
const listenAnywhere = async (server) => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return server.address().port;
};

test("acquires the lane on a free port + writes holder-info (pid, started-at)", async () => {
  const p = info();
  const a = await acquireGateLane({ port: 0, holderInfoPath: p });
  assert.equal(a.ok, true);
  assert.ok(existsSync(p));
  const h = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(h.pid, process.pid);
  assert.match(h.startedAt, /^\d{4}-\d\d-\d\dT/);
  await a.release();
  assert.equal(existsSync(p), false); // release unlinks the holder-info
});

test("acquire reports the port it actually bound (port 0 → the kernel-assigned port)", async () => {
  const a = await acquireGateLane({ port: 0, holderInfoPath: info() });
  assert.equal(a.ok, true);
  assert.ok(Number.isInteger(a.port) && a.port > 0, `acquire must return the bound port, got ${a.port}`);
  // The reported port really is held: a second bind on it must fail.
  const probe = net.createServer();
  const err = await new Promise((resolve) => {
    probe.once("error", resolve);
    probe.listen(a.port, "127.0.0.1", () => resolve(null));
  });
  if (!err) await new Promise((r) => probe.close(r));
  await a.release();
  assert.equal(err?.code, "EADDRINUSE");
});

test("gate-vs-gate contention → HARD-REFUSE naming the holder (pid/started-at), non-blocking", async () => {
  const p = info();
  const a = await acquireGateLane({ port: 0, holderInfoPath: p });
  assert.equal(a.ok, true);
  const b = await acquireGateLane({ port: a.port, holderInfoPath: p });
  assert.equal(b.ok, false);
  assert.equal(b.reason, "gate-holder");
  assert.equal(b.holder.pid, process.pid);
  assert.match(b.holder.startedAt, /^\d{4}-\d\d-\d\dT/);
  await a.release();
});

test("FOREIGN process on the port + NO holder-info → FAIL-CLOSED 'foreign-holder' (load-115)", async () => {
  const p = info(); // holder-info absent
  const foreign = net.createServer();
  const port = await listenAnywhere(foreign);
  try {
    const b = await acquireGateLane({ port, holderInfoPath: p });
    assert.equal(b.ok, false);
    assert.equal(b.reason, "foreign-holder");
  } finally {
    await new Promise((r) => foreign.close(r));
  }
});

test("P2 exclusivity (no SO_REUSEPORT): a second CONCURRENT bind on the same port MUST fail", async () => {
  // Load-bearing: with SO_REUSEPORT both binds would succeed and the mutex would silently vanish.
  const s1 = net.createServer();
  const port = await listenAnywhere(s1);
  const s2 = net.createServer();
  const err = await new Promise((resolve) => {
    s2.once("error", resolve);
    s2.listen(port, "127.0.0.1", () => resolve(null));
  });
  try {
    assert.ok(err, "second concurrent bind must fail — exclusivity IS the mutex");
    assert.equal(err.code, "EADDRINUSE");
  } finally {
    await new Promise((r) => s1.close(r));
    if (!err) await new Promise((r) => s2.close(r));
  }
});

test("P3: GATE_LANE_PORT is the ONE named lock (numeric, valid range, env-overridable)", () => {
  assert.equal(typeof GATE_LANE_PORT, "number");
  assert.ok(GATE_LANE_PORT > 0 && GATE_LANE_PORT < 65536);
  // NOTE: this test must NOT acquire the DEFAULT port — GATE_LANE_PORT is the real machine lock, so a
  // running gate (which runs this very suite via test:repo) HOLDS it; acquiring it here would EADDRINUSE
  // against the parent gate. acquire-uses-the-passed-port is covered by the explicit-port tests above.
});

test("P4 best-effort: a failed holder-info write does NOT lose the already-held lane (bind is the lock)", async () => {
  // Parent path is a FILE, so the holder-info mkdir/write fails — but the port bind still holds the lane.
  const f = join(mkdtempSync(join(tmpdir(), "gl-")), "notadir");
  writeFileSync(f, "x");
  const a = await acquireGateLane({ port: 0, holderInfoPath: join(f, "holder.json") });
  assert.equal(a.ok, true); // lane held despite the failed naming-only write
  await a.release();
});

test("release frees the lane (kernel-released) so a subsequent acquire succeeds", async () => {
  const p = info();
  const a = await acquireGateLane({ port: 0, holderInfoPath: p });
  assert.equal(a.ok, true);
  await a.release();
  // Re-acquire the SAME port: that is the property under test. Only the microseconds between release
  // and this bind are exposed to another process, not the whole suite as with a fixed port.
  const b = await acquireGateLane({ port: a.port, holderInfoPath: p });
  assert.equal(b.ok, true);
  await b.release();
});
