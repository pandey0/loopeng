import { pool } from "@loopeng/db";
import { afterAll, describe, expect, it } from "vitest";
import { acquireDeployLock, DeployLockError } from "./lock.js";

describe("acquireDeployLock", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("fails fast with DeployLockError on a second acquire for the same target while the first is still held", async () => {
    const target = `lock-test-target-${Math.random()}`;
    const lock = await acquireDeployLock(target);
    try {
      await expect(acquireDeployLock(target)).rejects.toThrow(DeployLockError);
    } finally {
      await lock.release();
    }
  });

  it("does not block a different target -- only the same target contends", async () => {
    const targetA = `lock-test-target-a-${Math.random()}`;
    const targetB = `lock-test-target-b-${Math.random()}`;
    const lockA = await acquireDeployLock(targetA);
    try {
      const lockB = await acquireDeployLock(targetB);
      await lockB.release();
    } finally {
      await lockA.release();
    }
  });

  it("lets a new acquire succeed immediately after release", async () => {
    const target = `lock-test-target-reuse-${Math.random()}`;
    const first = await acquireDeployLock(target);
    await first.release();
    const second = await acquireDeployLock(target);
    await second.release();
  });

  it("is crash-safe: releasing the underlying connection without calling release() still frees the lock (Postgres auto-releases session-level advisory locks when the session ends)", async () => {
    const target = `lock-test-target-crash-${Math.random()}`;
    // Simulates a process that acquired the lock and then died before ever
    // reaching its finally block -- acquireDeployLock's session-scoped
    // pg_try_advisory_lock is exactly what guarantees this can't wedge the
    // target forever. Reaching in to end the raw session (rather than
    // calling lock.release()) is the only way to simulate "the process is
    // gone" without actually killing this test process.
    const client = await pool.connect();
    const digest = await import("node:crypto").then((m) => m.createHash("sha256").update(target).digest());
    const key1 = digest.readInt32BE(0);
    const key2 = digest.readInt32BE(4);
    await client.query("SELECT pg_try_advisory_lock($1, $2)", [key1, key2]);
    client.release(true); // true = destroy the underlying connection instead of returning it to the pool

    // Give Postgres a moment to notice the connection is gone and clean up
    // its session-level state.
    await new Promise((r) => setTimeout(r, 200));

    const recovered = await acquireDeployLock(target);
    await recovered.release();
  });
});
