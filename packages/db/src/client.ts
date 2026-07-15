import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

// No hardcoded fallback (card 438646e5): a plaintext connection string
// baked into application source is exactly the kind of committed credential
// that made the original incident's DATABASE_URL-stripping fix (see
// AGENT_ENV_DENYLIST in @loopeng/agents) hollow -- stripping the env var is
// pointless if importing this module silently reconnects to the shared
// database anyway.
//
// Resolution is lazy (only on first actual pool/db use, not at module-import
// time) so that code which merely imports this module transitively -- e.g.
// the sub-agent MCP server process, which pulls in @loopeng/agents' barrel
// export for spawnSubAgent and drags in unrelated modules that import
// @loopeng/db -- doesn't need DATABASE_URL to exist just to load. Anything
// that actually tries to run a query still gets a loud, immediate error
// instead of a hardcoded credential silently standing in.
function resolveConnectionString(): string {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set -- @loopeng/db has no fallback credential (card 438646e5)");
  }
  return connectionString;
}

let realPool: Pool | undefined;
function getRealPool(): Pool {
  if (!realPool) realPool = new Pool({ connectionString: resolveConnectionString() });
  return realPool;
}

// Forwards every property/method access onto the lazily-constructed real
// instance, binding methods to it (not to the proxy) so internal `this`
// references inside pg/drizzle keep working exactly as if you'd been handed
// the real object all along -- the only difference is *when* getReal() (and
// therefore resolveConnectionString's check) actually runs: on first use,
// not on import.
function lazyProxy<T extends object>(getReal: () => T): T {
  return new Proxy({} as T, {
    get(_target, prop, _receiver) {
      const real = getReal();
      const value = Reflect.get(real as object, prop, real);
      return typeof value === "function" ? value.bind(real) : value;
    },
  });
}

export const pool: Pool = lazyProxy(getRealPool);

export type Database = ReturnType<typeof drizzle<typeof schema>>;

let realDb: Database | undefined;
function getRealDb(): Database {
  if (!realDb) realDb = drizzle(getRealPool(), { schema });
  return realDb;
}

export const db: Database = lazyProxy(getRealDb);
