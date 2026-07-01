import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./client.js";

async function main() {
  await migrate(db, { migrationsFolder: new URL("../migrations", import.meta.url).pathname });
  await pool.end();
  console.log("migrations applied");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
