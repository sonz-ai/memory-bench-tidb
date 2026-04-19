import fs from "node:fs";
import mysql from "mysql2/promise";
import path from "node:path";

/**
 * Bootstrap-aware migration. Connects WITHOUT a database selected, runs
 * CREATE DATABASE, then runs the remaining schema inside that database.
 * Avoids "Unknown database 'memory_bench'" on first run.
 */
const schemaPath = path.join(import.meta.dir, "schema.sql");

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function main() {
  const host = must("TIDB_HOST");
  const port = parseInt(process.env.TIDB_PORT ?? "4000", 10);
  const user = must("TIDB_USER");
  const password = must("TIDB_PASSWORD");
  const database = process.env.TIDB_DATABASE ?? "memory_bench";
  const caPath = process.env.TIDB_SSL_CA;

  const ssl =
    caPath && fs.existsSync(caPath)
      ? { ca: fs.readFileSync(caPath, "utf8"), minVersion: "TLSv1.2" as const }
      : { minVersion: "TLSv1.2" as const, rejectUnauthorized: true };

  // Step 1: connect without DB, ensure DB exists.
  const boot = await mysql.createConnection({
    host,
    port,
    user,
    password,
    ssl,
  });
  await boot.query(`CREATE DATABASE IF NOT EXISTS \`${database}\``);
  console.log(`OK: ensured database ${database}`);
  await boot.end();

  // Step 2: connect into the DB, run table DDL statements.
  const conn = await mysql.createConnection({
    host,
    port,
    user,
    password,
    database,
    ssl,
    multipleStatements: false,
  });

  const sql = fs.readFileSync(schemaPath, "utf8");
  const statements = sql
    .split(/;\s*\n/)
    // Strip leading comment lines so real DDL isn't filtered out.
    .map((s) =>
      s
        .split("\n")
        .filter((line) => !/^\s*--/.test(line))
        .join("\n")
        .trim(),
    )
    // Skip CREATE DATABASE (done) and USE (implicit via connection) and empty blocks
    .filter(
      (s) =>
        s.length > 0 && !/^CREATE\s+DATABASE/i.test(s) && !/^USE\s+/i.test(s),
    );

  for (const stmt of statements) {
    try {
      await conn.query(stmt);
      console.log("OK:", stmt.slice(0, 80).replace(/\s+/g, " "));
    } catch (err: any) {
      console.error("FAIL:", stmt.slice(0, 80), "\n  →", err.message);
    }
  }

  // Best-effort ALTER TABLE pass for existing tables that predate the
  // five-lens schema additions. Each statement is independent — we swallow
  // "Duplicate column name" and equivalent errors so re-running is idempotent.
  const alters: Array<{ label: string; sql: string }> = [
    {
      label: "lens column",
      sql: "ALTER TABLE memories ADD COLUMN lens VARCHAR(16)",
    },
    {
      label: "subject column",
      sql: "ALTER TABLE memories ADD COLUMN subject VARCHAR(128)",
    },
    {
      label: "predicate column",
      sql: "ALTER TABLE memories ADD COLUMN predicate VARCHAR(64)",
    },
    {
      label: "object column",
      sql: "ALTER TABLE memories ADD COLUMN object VARCHAR(256)",
    },
    {
      label: "valence column",
      sql: "ALTER TABLE memories ADD COLUMN valence FLOAT",
    },
    {
      label: "kind column",
      sql: "ALTER TABLE memories ADD COLUMN kind VARCHAR(24)",
    },
    {
      label: "topic column",
      sql: "ALTER TABLE memories ADD COLUMN topic VARCHAR(64)",
    },
    {
      label: "superseded_at column",
      sql: "ALTER TABLE memories ADD COLUMN superseded_at DATETIME",
    },
    {
      label: "supersedes_id column",
      sql: "ALTER TABLE memories ADD COLUMN supersedes_id BIGINT",
    },
    {
      label: "idx_spo",
      sql: "ALTER TABLE memories ADD INDEX idx_spo (approach, agent_id, subject, predicate)",
    },
    {
      label: "idx_topic",
      sql: "ALTER TABLE memories ADD INDEX idx_topic (approach, agent_id, topic)",
    },
    {
      label: "idx_alive",
      sql: "ALTER TABLE memories ADD INDEX idx_alive (approach, agent_id, superseded_at)",
    },
    // runs table — token + cost + distractor instrumentation.
    {
      label: "runs.embed_tokens",
      sql: "ALTER TABLE runs ADD COLUMN embed_tokens INT",
    },
    {
      label: "runs.ingest_tokens_in",
      sql: "ALTER TABLE runs ADD COLUMN ingest_tokens_in INT",
    },
    {
      label: "runs.ingest_tokens_out",
      sql: "ALTER TABLE runs ADD COLUMN ingest_tokens_out INT",
    },
    {
      label: "runs.ingest_embed_tokens",
      sql: "ALTER TABLE runs ADD COLUMN ingest_embed_tokens INT",
    },
    {
      label: "runs.ingest_latency_ms",
      sql: "ALTER TABLE runs ADD COLUMN ingest_latency_ms INT",
    },
    {
      label: "runs.distractor_k",
      sql: "ALTER TABLE runs ADD COLUMN distractor_k INT NOT NULL DEFAULT 0",
    },
    {
      label: "runs.idx_distractor",
      sql: "ALTER TABLE runs ADD INDEX idx_distractor (approach, distractor_k)",
    },
  ];

  for (const a of alters) {
    try {
      await conn.query(a.sql);
      console.log(`OK: added ${a.label}`);
    } catch (err: any) {
      const msg = err?.message ?? "";
      if (/Duplicate|already exists|exists in table/i.test(msg)) {
        console.log(`SKIP ${a.label}: already present`);
      } else {
        console.warn(`WARN ${a.label}:`, msg.slice(0, 120));
      }
    }
  }

  try {
    await conn.query(
      "ALTER TABLE memories ADD FULLTEXT INDEX ft_content (content) WITH PARSER STANDARD",
    );
    console.log("OK: fulltext index on memories(content)");
  } catch (err: any) {
    console.warn(
      "SKIP fulltext index:",
      err.message,
      "(LIKE-based fallback in scoring)",
    );
  }

  await conn.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
