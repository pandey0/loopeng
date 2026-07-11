import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { killProcessGroup } from "./claude-cli.js";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for condition");
}

// Regression test for the 2026-07-02 incident: an implementer agent's Bash
// tool backgrounded a dev server (`tsx watch ... &`) that outlived the
// claude CLI turn that started it, because only the CLI's own PID was ever
// torn down. Reproduces the same shape without depending on the real claude
// binary -- spawn a detached "leader" process (standing in for the CLI) that
// itself backgrounds a long-running child (standing in for the dev server),
// then confirm killProcessGroup on the leader's pid takes the backgrounded
// child down too, not just the leader.
describe("killProcessGroup", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it("kills a backgrounded descendant left in the same process group, not just the direct child", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "claude-cli-process-group-"));
    dirs.push(dir);
    const pidFile = path.join(dir, "child.pid");

    // Mirrors what the claude CLI's Bash tool does when an agent starts a
    // dev server: background a long-running process with `&` and return.
    const leader = spawn("bash", ["-c", `sleep 60 & echo $! > ${pidFile}; wait`], {
      detached: true,
      stdio: "ignore",
    });
    if (!leader.pid) throw new Error("leader process failed to spawn (no pid)");
    const leaderPid = leader.pid;

    await waitUntil(async () => {
      try {
        return (await readFile(pidFile, "utf8")).trim().length > 0;
      } catch {
        return false;
      }
    });
    const backgroundedPid = Number((await readFile(pidFile, "utf8")).trim());

    expect(isAlive(leaderPid)).toBe(true);
    expect(isAlive(backgroundedPid)).toBe(true);

    killProcessGroup(leaderPid, "SIGKILL");

    await waitUntil(() => !isAlive(leaderPid) && !isAlive(backgroundedPid));

    expect(isAlive(leaderPid)).toBe(false);
    expect(isAlive(backgroundedPid)).toBe(false);
  });

  it("is a silent no-op for a pid whose group is already gone", () => {
    // Picks a pid almost certainly unused; either way killProcessGroup must
    // swallow ESRCH rather than throw -- callers rely on this at every
    // run-finished cleanup site regardless of whether the group is still alive.
    expect(() => killProcessGroup(999_999, "SIGTERM")).not.toThrow();
  });
});
