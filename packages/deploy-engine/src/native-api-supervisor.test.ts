import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NativeApiSupervisor, type SpawnFn } from "./native-api-supervisor.js";

class FakeChild extends EventEmitter {
  pid: number;
  exitCode: number | null = null;
  killCalls: string[] = [];

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(signal: string) {
    this.killCalls.push(signal);
    return true;
  }

  simulateExit(code: number | null, signal: string | null) {
    this.exitCode = code;
    this.emit("exit", code, signal);
  }
}

describe("NativeApiSupervisor", () => {
  let tmpDir: string;
  let requestFile: string;
  let pidFile: string;
  let spawned: FakeChild[];
  let spawnFn: SpawnFn;
  let nextPid: number;
  let supervisor: NativeApiSupervisor;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "native-api-supervisor-test-"));
    requestFile = path.join(tmpDir, "restart-request.json");
    pidFile = path.join(tmpDir, "native-api.pid");
    spawned = [];
    nextPid = 1000;
    spawnFn = (() => {
      const child = new FakeChild(nextPid++);
      spawned.push(child);
      return child as unknown as ReturnType<SpawnFn>;
    }) as SpawnFn;

    supervisor = new NativeApiSupervisor({
      repoRoot: tmpDir,
      requestFile,
      pidFile,
      pollIntervalMs: 5,
      gracefulTimeoutMs: 200,
      crashBackoffMs: 5,
      spawnFn,
      log: () => {},
    });
  });

  afterEach(async () => {
    await supervisor.stop();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("spawns exactly one child on start", async () => {
    await supervisor.start();
    expect(spawned.length).toBe(1);
  });

  it("SIGTERMs the old child and spawns a new one when a restart is requested", async () => {
    await supervisor.start();
    expect(spawned.length).toBe(1);
    const first = spawned[0]!;

    await writeFile(requestFile, JSON.stringify({ requestId: "req-1", requestedAt: new Date().toISOString() }));

    // Give the poll loop a few ticks to pick up the new requestId and call
    // terminate(), which is what actually sends SIGTERM.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(first.killCalls).toContain("SIGTERM");

    // terminate() awaits the child's own "exit" event before spawning the
    // replacement -- simulate the old process actually shutting down.
    first.simulateExit(0, null);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(spawned.length).toBe(2);
  });

  it("ignores a restart-request requestId it already applied (adopted on start)", async () => {
    await writeFile(requestFile, JSON.stringify({ requestId: "already-applied", requestedAt: new Date().toISOString() }));
    await supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Only the initial spawn -- the pre-existing requestId must not trigger a
    // second restart immediately after boot.
    expect(spawned.length).toBe(1);
  });

  it("respawns automatically when the child exits unexpectedly (crash)", async () => {
    await supervisor.start();
    expect(spawned.length).toBe(1);
    spawned[0]!.simulateExit(1, null);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(spawned.length).toBe(2);
  });
});
