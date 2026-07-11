import { createHash } from "node:crypto";
import { pool } from "@loopeng/db";

export class DeployLockError extends Error {
  constructor(public readonly target: string) {
    super(`another deploy is already in progress for target "${target}" -- refusing to run concurrently`);
    this.name = "DeployLockError";
  }
}

export interface DeployLockHandle {
  release(): Promise<void>;
}

// pg_try_advisory_lock takes two int4 keys, not an arbitrary string -- hash
// the target (a repo root path) down to two signed 32-bit ints. Collisions
// only ever make two *different* targets share a lock (over-serializing
// deploys that didn't need to wait on each other), never make two deploys
// against the same target fail to serialize, so a cheap hash is fine here.
function lockKeys(target: string): [number, number] {
  const digest = createHash("sha256").update(target).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

// Session-level Postgres advisory lock, one per deploy target (a project's
// repo root -- the thing `docker compose up` and the shared base-branch
// checkout actually contend on). Non-blocking (pg_try_advisory_lock, not
// pg_advisory_lock): a second deploy against the same target fails fast
// with DeployLockError instead of queuing, so a caller gets a clear signal
// immediately rather than hanging for however long the in-flight deploy
// takes.
//
// Crash safety is the reason this is a *session*-level advisory lock held
// on a dedicated connection checked out of the pool, not a DB row: if the
// process dies mid-deploy, its connection to Postgres drops and Postgres
// releases every advisory lock held by that backend automatically -- no
// stale lock can outlive the process that took it, so a crash can never
// require a human to manually clear a lock row. release() is still the
// normal path (called from the pipeline's finally block) and additionally
// unlocks explicitly before returning the connection to the pool.
export async function acquireDeployLock(target: string): Promise<DeployLockHandle> {
  const client = await pool.connect();
  const [key1, key2] = lockKeys(target);
  let locked = false;
  try {
    const { rows } = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1, $2) AS locked", [key1, key2]);
    locked = rows[0]?.locked === true;
  } catch (err) {
    client.release();
    throw err;
  }

  if (!locked) {
    client.release();
    throw new DeployLockError(target);
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await client.query("SELECT pg_advisory_unlock($1, $2)", [key1, key2]);
      } finally {
        client.release();
      }
    },
  };
}
