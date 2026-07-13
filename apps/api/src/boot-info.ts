import { randomUUID } from "node:crypto";

// Generated once per process start, not per-request -- this is exactly the
// "boot-timestamp/version marker" the deploy pipeline polls /health for to
// confirm a restart actually swapped in a new process rather than the same
// stale one still answering requests (see card 6d4dc01a: the native api
// process ran 3+ days of merged-but-never-loaded code because nothing ever
// verified the process itself had changed, only that /health returned ok).
export const BOOT_ID = randomUUID();
export const BOOTED_AT = new Date().toISOString();
