import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface NativeApiRestartOptions {
  // Where the native api's own /health lives -- same URL the docker-compose
  // provider already polls after a web rebuild.
  healthUrl: string;
  // File the native-api-supervisor process watches for restart requests.
  // Deliberately outside the git-tracked repoRoot: writing into repoRoot
  // would make the next deploy's `git status` isClean() check see an
  // untracked file and refuse to merge (see docker-compose.ts).
  requestFile?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

export interface NativeApiRestartResult {
  restarted: boolean;
  detail: Record<string, unknown>;
}

export const DEFAULT_NATIVE_API_REQUEST_FILE = path.join(os.tmpdir(), "loopeng-native-api-supervisor", "restart-request.json");

interface HealthProbe {
  ok: boolean;
  bootId?: string;
  bootedAt?: string;
  body?: unknown;
}

async function probeHealth(healthUrl: string, fetchImpl: typeof fetch): Promise<HealthProbe> {
  try {
    const res = await fetchImpl(`${healthUrl}/health`, { signal: AbortSignal.timeout(5000) });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok && body.status === "ok", bootId: body.bootId as string | undefined, bootedAt: body.bootedAt as string | undefined, body };
  } catch (err) {
    return { ok: false, body: { error: (err as Error).message } };
  }
}

// Requests a restart of the native api process via the file-based marker
// native-api-supervisor.ts watches, then polls /health until it reports a
// *different* bootId than before the request -- proof a new process is
// actually answering, not just that the old one is still up and healthy.
// A stale process passes a plain DB-connectivity health check just fine
// (that's exactly how the 3-day-stale-api incident went unnoticed), so
// "healthy" alone is never sufficient here.
export async function restartNativeApi(opts: NativeApiRestartOptions): Promise<NativeApiRestartResult> {
  const requestFile = opts.requestFile ?? DEFAULT_NATIVE_API_REQUEST_FILE;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const before = await probeHealth(opts.healthUrl, fetchImpl);

  const token = randomUUID();
  await mkdir(path.dirname(requestFile), { recursive: true });
  await writeFile(requestFile, JSON.stringify({ token, requestedAt: new Date().toISOString() }));

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const after = await probeHealth(opts.healthUrl, fetchImpl);
    if (after.ok && after.bootId && after.bootId !== before.bootId) {
      return {
        restarted: true,
        detail: { token, previousBootId: before.bootId ?? null, newBootId: after.bootId, newBootedAt: after.bootedAt ?? null },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return {
    restarted: false,
    detail: {
      token,
      reason: "native api did not report a new bootId within timeout -- supervisor may not be running",
      previousBootId: before.bootId ?? null,
    },
  };
}
