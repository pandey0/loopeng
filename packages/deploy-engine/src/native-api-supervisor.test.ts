import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { NativeApiSupervisor, type SpawnFn } from "./native-api-supervisor.js";

class FakeChild extends EventEmitter {
  pid: number;
  exitCode: number | null = null;

  constructor(pid: number) {
    super();
    this.pid = pid;
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
  let killSpy: MockInstance<typeof process.kill>;

  beforeEach(async () => {
    // terminate()/stop() signal the real process group via process.kill
    // (killProcessGroup, @loopeng/agents) -- the fake pids here (1000, 1001,
    // ...) don't correspond to a real process group, so without this mock
    // every test (including afterEach's supervisor.stop()) would issue a
    // real syscall that's essentially guaranteed to ESRCH. Mocked globally
    // so no test needs to remember to do this itself.
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
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
    killSpy.mockRestore();
  });

  it("spawns exactly one child on start", async () => {
    await supervisor.start();
    expect(spawned.length).toBe(1);
  });

  it("SIGTERMs the old child's whole process group and spawns a new one when a restart is requested", async () => {
    // terminate() signals the process *group* (process.kill(-pid, ...)),
    // not child.kill() directly -- see native-api-supervisor.ts's comment on
    // why: this.command is a multi-layer wrapper chain (pnpm -> sh -> tsx ->
    // node), and only a group-wide signal reliably reaches the real
    // grandchild process actually holding the port.
    await supervisor.start();
    expect(spawned.length).toBe(1);
    const first = spawned[0]!;

    await writeFile(requestFile, JSON.stringify({ requestId: "req-1", requestedAt: new Date().toISOString() }));

    // Give the poll loop a few ticks to pick up the new requestId and call
    // terminate(), which is what actually sends SIGTERM.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(killSpy).toHaveBeenCalledWith(-first.pid, "SIGTERM");

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
