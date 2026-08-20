import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression test for card 438646e5. infrastructure/docker/docker-compose.yml
// used to hardcode POSTGRES_PASSWORD/DATABASE_URL as a bare literal
// ("loopeng"), identical to the value documented in .env.example -- so
// "the one real instance" this file deploys (see docs/ARCHITECTURE.md) had its
// actual production DB credential sitting in a committed file, reachable by
// a plain read from any agent worktree regardless of what got stripped from
// a spawned process's env (AGENT_ENV_DENYLIST in
// packages/agents/src/claude-cli.ts). This asserts the password is now
// parameterized via ${DB_PASSWORD:-...} -- same pattern already used for
// WEB_API_KEY -- so a real deployment can set a real secret via
// infrastructure/docker/.env (gitignored) without it ever appearing here.
describe("infrastructure/docker/docker-compose.yml DB credential", () => {
  it("parameterizes the Postgres password instead of hardcoding it", async () => {
    const composePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../infrastructure/docker/docker-compose.yml",
    );
    const compose = await readFile(composePath, "utf8");

    expect(compose).not.toMatch(/POSTGRES_PASSWORD:\s*loopeng\s*$/m);
    expect(compose).not.toMatch(/DATABASE_URL:\s*postgresql:\/\/loopeng:loopeng@/);
    expect(compose).toMatch(/POSTGRES_PASSWORD:\s*\$\{DB_PASSWORD:-/);
    expect(compose).toMatch(/DATABASE_URL:\s*postgresql:\/\/loopeng:\$\{DB_PASSWORD:-/);
  });
});
