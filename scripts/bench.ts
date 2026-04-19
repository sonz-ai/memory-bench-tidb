import fs from "node:fs";
import path from "node:path";
import { getPool } from "../src/db/client.ts";
import { APPROACHES } from "../src/dispatch.ts";
import type { Approach } from "../src/types.ts";
import { runBench, summarize } from "../src/eval/runner.ts";

async function main() {
  const perSlice = parseInt(process.env.PER_SLICE ?? "10", 10);
  const only = process.env.APPROACHES?.split(",").filter(Boolean) as
    | Approach[]
    | undefined;
  const skipIngest = process.env.SKIP_INGEST === "1";

  const outcomes = await runBench({
    perSlice,
    approaches: only ?? APPROACHES,
    skipIngest,
  });

  const summary = summarize(outcomes);
  console.log("\n=== Summary ===");
  console.table(summary);

  const resultsDir = path.join(import.meta.dir, "..", "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(resultsDir, `bench-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ summary, outcomes }, null, 2));
  console.log(`\nWrote ${outPath}`);

  await getPool().end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
