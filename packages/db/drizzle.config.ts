import { defineConfig } from "drizzle-kit";

// No hardcoded fallback here either (card 438646e5) -- same reasoning as
// packages/db/src/client.ts: a real connection string baked into committed
// source is a credential any agent worktree can read regardless of what's
// stripped from its own process env. drizzle-kit only runs as an explicit
// dev/CI command (`drizzle-kit push`/`generate`/`migrate`), never imported
// by application code, so it can fail fast if DATABASE_URL is missing.
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set -- drizzle.config.ts has no fallback credential (card 438646e5)");
}

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
