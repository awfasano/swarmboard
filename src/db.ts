import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

// Return BIGINT columns as JS numbers; ids will not exceed 2^53 in practice.
pg.types.setTypeParser(20, v => Number(v));
pg.types.setTypeParser(1016 as Parameters<typeof pg.types.setTypeParser>[0], v => (v === "{}" ? [] : v.slice(1, -1).split(",").map(Number)));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.poolMax,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  keepAlive: true,
  // No single query may hold a connection for long.
  statement_timeout: 15_000,
});
// An idle client dying (failover, maintenance) must not crash the process.
pool.on("error", err => console.error("pg pool error:", err.message));

export async function query<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query<T>(text, params);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T | undefined> {
  return (await query<T>(text, params))[0];
}

// Apply db/migrations/NNN_*.sql in order, each once, in its own transaction.
// An advisory lock keeps several instances booting at once from racing.
export async function migrate(): Promise<void> {
  const dir = fileURLToPath(new URL("../db/migrations/", import.meta.url));
  const files = (await readdir(dir)).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  const client = await connectWithRetry();
  let unlocked = false;
  try {
    await client.query("SET lock_timeout = '60s'");
    await client.query("SELECT pg_advisory_lock(727274)");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    const done = new Set((await client.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map(r => r.version));
    for (const file of files) {
      if (done.has(file)) continue;
      await client.query("BEGIN");
      try {
        await client.query(await readFile(dir + file, "utf8"));
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`migrated ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    unlocked = await client.query("SELECT pg_advisory_unlock(727274)").then(() => true, () => false);
    // A connection that may still hold the lock must not go back to the pool.
    client.release(!unlocked);
  }
}

// The database may still be starting when the app boots (cold start, failover).
async function connectWithRetry(attempts = 8): Promise<pg.PoolClient> {
  for (let i = 1; ; i++) {
    try {
      return await pool.connect();
    } catch (err) {
      if (i >= attempts) throw err;
      console.error(`database not ready (${(err as Error).message}); retrying`);
      await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** i, 15_000)));
    }
  }
}
