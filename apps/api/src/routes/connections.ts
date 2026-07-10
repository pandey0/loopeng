import type { FastifyPluginAsync } from "fastify";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// GitHub here is a workspace-wide env var token (packages/connectors/src/github.ts
// reads GITHUB_TOKEN/GITHUB_REPO directly), not a per-user OAuth grant -- there's
// no OAuth App registered anywhere in this codebase. "Connected" means those two
// env vars are actually set on the api process right now, nothing more.
function githubStatus(): { connected: boolean; repo: string | null } {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  return { connected: !!token && !!repo, repo: repo ?? null };
}

// Every implementer/reviewer/planner/designer run shells out to the real
// `claude` CLI (packages/agents/src/claude-cli.ts) -- there's no separate
// "connection" to establish, it's either installed and authenticated on
// this machine or it isn't. `claude --version` is a cheap, real check.
async function claudeCliStatus(): Promise<{ connected: boolean; version: string | null }> {
  try {
    const { stdout } = await execFileAsync("claude", ["--version"], { timeout: 5000 });
    return { connected: true, version: stdout.trim() };
  } catch {
    return { connected: false, version: null };
  }
}

export const connectionRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/connections", async () => {
    const [claude, github] = await Promise.all([claudeCliStatus(), Promise.resolve(githubStatus())]);
    return { github, claude };
  });
};
