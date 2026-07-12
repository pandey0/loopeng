import { spawn, type ChildProcess } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_NATIVE_API_REQUEST_FILE } from "./native-api.js";

export type SpawnFn = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "inherit" }) => ChildProcess;

export interface NativeApiSupervisorOptions {
  repoRoot: string;
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  requestFile?: string;
  pidFile?: string;
  pollIntervalMs?: number;
  gracefulTimeoutMs?: number;
  crashBackoffMs?: number;
  spawnFn?: SpawnFn;
  log?: (msg: string) => void;
}

// Owns the *actual* lifecycle of the native `apps/api` process: this is the
// "deploy-engine spawning a supervised child it can SIGTERM+respawn" half of
// card 6d4dc01a's fix direction. It runs as its own long-lived OS process,
// separate from the api process it supervises, specifically because the api
// process is where the orchestrator (and therefore the deploy pipeline that
// needs to trigger this restart) actually runs -- a process can't safely
// SIGTERM itself mid-deploy and expect its own remaining async work (writing
// deploy_records, applyTransition, tearing down the worktree) to still run.
// Decoupling via a request file means the deploy step never touches its own
// process lifecycle: it just asks, and later confirms via /health.
export class NativeApiSupervisor {
  private readonly repoRoot: string;
  private readonly command: string;
  private readonly args: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly requestFile: string;
  private readonly pidFile: string;
  private readonly pollIntervalMs: number;
  private readonly gracefulTimeoutMs: number;
  private readonly crashBackoffMs: number;
  private readonly spawnFn: SpawnFn;
  private readonly log: (msg: string) => void;

  private child: ChildProcess | null = null;
  private lastSeenToken: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private restarting = false;
  private stopped = false;

  constructor(opts: NativeApiSupervisorOptions) {
    this.repoRoot = opts.repoRoot;
    this.command = opts.command ?? "pnpm";
    this.args = opts.args ?? ["--filter", "@loopeng/api", "run", "start"];
    this.env = opts.env ?? process.env;
    this.requestFile = opts.requestFile ?? DEFAULT_NATIVE_API_REQUEST_FILE;
    this.pidFile = opts.pidFile ?? path.join(path.dirname(this.requestFile), "native-api.pid");
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.gracefulTimeoutMs = opts.gracefulTimeoutMs ?? 10_000;
    this.crashBackoffMs = opts.crashBackoffMs ?? 2000;
    this.spawnFn = opts.spawnFn ?? ((cmd, args, options) => spawn(cmd, args, options));
    this.log = opts.log ?? ((msg) => console.log(`[native-api-supervisor] ${msg}`));
  }

  async start(): Promise<void> {
    await mkdir(path.dirname(this.requestFile), { recursive: true });
    // Adopt whatever restart token already exists so a supervisor restarted
    // itself doesn't immediately treat a stale, already-applied request as
    // new and restart the child it just spawned a second time.
    this.lastSeenToken = await this.readRequestToken();
    this.spawnChild();
    this.pollTimer = setInterval(() => {
      this.pollForRestartRequest().catch((err) => this.log(`poll error: ${(err as Error).message}`));
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.child) this.child.kill("SIGTERM");
  }

  private async readRequestToken(): Promise<string | null> {
    try {
      const raw = await readFile(this.requestFile, "utf8");
      const parsed = JSON.parse(raw) as { token?: string };
      return parsed.token ?? null;
    } catch {
      return null;
    }
  }

  private async pollForRestartRequest(): Promise<void> {
    if (this.stopped || this.restarting) return;
    const token = await this.readRequestToken();
    if (token && token !== this.lastSeenToken) {
      this.lastSeenToken = token;
      this.log(`restart requested (token=${token})`);
      await this.restartChild();
    }
  }

  private spawnChild(): void {
    const child = this.spawnFn(this.command, this.args, { cwd: this.repoRoot, env: this.env, stdio: "inherit" });
    this.child = child;
    if (child.pid) {
      writeFile(this.pidFile, String(child.pid)).catch((err) => this.log(`failed to write pidfile: ${(err as Error).message}`));
    }
    child.on("exit", (code, signal) => {
      if (this.stopped || this.restarting) return;
      // Not a restart we asked for -- the child crashed or was killed out
      // from under us. Respawn after a short backoff so a persistently
      // crash-looping api doesn't spin the CPU with instant restarts.
      this.log(`native api exited unexpectedly (code=${code}, signal=${signal}), respawning in ${this.crashBackoffMs}ms`);
      setTimeout(() => {
        if (!this.stopped) this.spawnChild();
      }, this.crashBackoffMs);
    });
  }

  private async restartChild(): Promise<void> {
    this.restarting = true;
    try {
      const old = this.child;
      if (old && old.exitCode === null) {
        await this.terminate(old);
      }
      this.spawnChild();
    } finally {
      this.restarting = false;
    }
  }

  private terminate(child: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, this.gracefulTimeoutMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
}

// CLI entrypoint: `tsx native-api-supervisor.ts <repoRoot>` starts the
// supervisor as its own long-lived process. This is what the one real
// instance's boot procedure should run instead of `pnpm --filter
// @loopeng/api run start` directly, so restarts triggered by a deploy have
// something outside the api process itself to act on them.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const repoRoot = process.argv[2] ?? process.cwd();
  const supervisor = new NativeApiSupervisor({ repoRoot });
  supervisor.start().catch((err) => {
    console.error("[native-api-supervisor] failed to start:", err);
    process.exit(1);
  });
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      supervisor.stop().finally(() => process.exit(0));
    });
  }
}
