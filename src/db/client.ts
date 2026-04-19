import mysql from "mysql2/promise";
import fs from "node:fs";

let pool: mysql.Pool | null = null;

export function getPool(): mysql.Pool {
  if (pool) return pool;

  const host = must("TIDB_HOST");
  const port = parseInt(process.env.TIDB_PORT ?? "4000", 10);
  const user = must("TIDB_USER");
  const password = must("TIDB_PASSWORD");
  const database = process.env.TIDB_DATABASE ?? "memory_bench";
  const caPath = process.env.TIDB_SSL_CA;

  pool = mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    ssl:
      caPath && fs.existsSync(caPath)
        ? { ca: fs.readFileSync(caPath, "utf8"), minVersion: "TLSv1.2" }
        : { minVersion: "TLSv1.2", rejectUnauthorized: true },
    waitForConnections: true,
    // Smaller pool — TiDB Cloud Serverless closes idle connections under
    // sustained mixed workloads; fewer long-lived sockets = fewer chances
    // for PROTOCOL_CONNECTION_LOST mid-INSERT. Eight is comfortably above
    // our ingest fan-out.
    connectionLimit: parseInt(process.env.DB_POOL_SIZE ?? "8", 10),
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000, // ping at 10s to keep sockets warm
    idleTimeout: 60_000, // evict idle sockets before TiDB does
    maxIdle: 4,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });

  return pool;
}

/**
 * Wrap a SQL operation with a single retry on transient connection loss.
 * TiDB Cloud Serverless occasionally closes pooled sockets; mysql2 surfaces
 * this as PROTOCOL_CONNECTION_LOST / ECONNRESET. A fresh acquire usually
 * succeeds immediately.
 */
export async function withRetry<T>(
  op: () => Promise<T>,
  label = "query",
  maxRetries = 2,
): Promise<T> {
  let attempt = 0;
  let lastErr: unknown;
  while (attempt <= maxRetries) {
    try {
      return await op();
    } catch (err: any) {
      lastErr = err;
      const code = err?.code ?? err?.cause?.code;
      const transient =
        code === "PROTOCOL_CONNECTION_LOST" ||
        code === "ECONNRESET" ||
        code === "ETIMEDOUT" ||
        code === "EPIPE";
      if (!transient || attempt === maxRetries) throw err;
      attempt++;
      const backoff = 200 * attempt;
      console.warn(
        `[db] ${label} transient (${code}); retry ${attempt}/${maxRetries} in ${backoff}ms`,
      );
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

/** TiDB vector literal: [0.1, 0.2, ...] → '[0.1,0.2,...]' string. */
export function vecLiteral(v: number[]): string {
  return "[" + v.map((x) => x.toFixed(6)).join(",") + "]";
}

export async function withTx<T>(
  fn: (c: mysql.PoolConnection) => Promise<T>,
): Promise<T> {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}
