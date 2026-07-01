import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://loopeng:loopeng@localhost:5432/loopeng";

export const pool = new Pool({ connectionString });

export const db = drizzle(pool, { schema });

export type Database = typeof db;
