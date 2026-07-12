import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { restartNativeApi } from "./native-api.js";

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
    expect(written.token).toBe(result.detail.token);
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
