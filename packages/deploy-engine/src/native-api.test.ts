import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requestNativeApiRestart, restartNativeApi } from "./native-api.js";

describe("restartNativeApi", () => {
  let tmpDir: string;
  let requestFile: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "native-api-test-"));
    requestFile = path.join(tmpDir, "restart-request.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes a restart request and resolves once /health reports a new bootId", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      // First call is the "before" probe; every call after that simulates
      // the supervisor having swapped in a fresh process by the 3rd poll.
      const bootId = calls <= 3 ? "boot-old" : "boot-new";
      return new Response(JSON.stringify({ status: "ok", bootId, bootedAt: "2026-07-13T00:00:00.000Z" }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await restartNativeApi({
      healthUrl: "http://localhost:4000",
      requestFile,
      fetchImpl,
      pollIntervalMs: 5,
      timeoutMs: 2000,
    });

    expect(result.restarted).toBe(true);
    expect(result.detail.previousBootId).toBe("boot-old");
    expect(result.detail.newBootId).toBe("boot-new");

    const written = JSON.parse(await readFile(requestFile, "utf8"));
    expect(written.requestId).toBe(result.detail.requestId);
  });

  it("reports restarted:false when the bootId never changes before the timeout", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ status: "ok", bootId: "boot-stale" }), { status: 200 })) as unknown as typeof fetch;

    const result = await restartNativeApi({
      healthUrl: "http://localhost:4000",
      requestFile,
      fetchImpl,
      pollIntervalMs: 5,
      timeoutMs: 40,
    });

    expect(result.restarted).toBe(false);
    expect(result.detail.reason).toMatch(/did not report a new bootId/);
  });

  it("reports restarted:false when /health is unreachable the whole time", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await restartNativeApi({
      healthUrl: "http://localhost:4000",
      requestFile,
      fetchImpl,
      pollIntervalMs: 5,
      timeoutMs: 40,
    });

    expect(result.restarted).toBe(false);
  });
});

// Regression coverage for the 2026-07-15 incident: restartNativeApi (above)
// can never resolve when called from inside the very process it's asking to
// be restarted -- native-api-supervisor.ts terminates the old process before
// spawning the new one, so the caller is always dead before a new bootId
// could exist to observe. Every deploy that used to await restartNativeApi
// directly (docker-compose.ts) got silently orphaned mid-poll. This is the
// fire-and-forget alternative deploy callers use instead: writes the request
// and returns immediately, trusting the supervisor (tested separately in
// native-api-supervisor.test.ts) to actually carry it out.
describe("requestNativeApiRestart", () => {
  let tmpDir: string;
  let requestFile: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "request-native-api-restart-test-"));
    requestFile = path.join(tmpDir, "restart-request.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes the request file and returns immediately, without polling /health at all", async () => {
    const result = await requestNativeApiRestart(requestFile);

    const written = JSON.parse(await readFile(requestFile, "utf8"));
    expect(written.requestId).toBe(result.requestId);
    expect(typeof written.requestedAt).toBe("string");
  });

  it("creates the request file's parent directory if it doesn't exist yet", async () => {
    const nestedFile = path.join(tmpDir, "nested", "dir", "restart-request.json");
    await requestNativeApiRestart(nestedFile);
    const written = JSON.parse(await readFile(nestedFile, "utf8"));
    expect(written.requestId).toBeDefined();
  });
});
