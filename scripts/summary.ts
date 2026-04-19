/**
 * Read whatever's in the `runs` table RIGHT NOW and print a summary.
 * Safe to run mid-bench — we just summarize what's there so far.
 *
 * Emits:
 *   - pivoted stdout table (approach × slice with hits/n)
 *   - ASCII bar charts per slice
 *   - overall ranking
 *   - Markdown table (for the deck / README)
 *
 * For the SVG chart that goes into results/, use scripts/chart.ts
 * after the full bench has written a results/bench-*.json file.
 */
import fs from "node:fs";
import path from "node:path";
import { getPool } from "../src/db/client.ts";
import { TARGET_SLICES, type Slice } from "../src/eval/fixtures.ts";
import { costFromFlat } from "../src/pricing.ts";
import {
  ANSWER_MODEL,
  COMPOSE_MODEL,
  EMBED_MODEL,
  WRITE_MODEL,
} from "../src/llm.ts";

type Approach =
  | "raw_vector"
  | "progressive_summary"
  | "hierarchical"
  | "typed_facts"
  | "spo_supersede";

const APPROACH_ORDER: Approach[] = [
  "raw_vector",
  "progressive_summary",
  "hierarchical",
  "typed_facts",
  "spo_supersede",
];
const APPROACH_LABEL: Record<Approach, string> = {
  raw_vector: "Raw vector",
  progressive_summary: "Progressive summary",
  hierarchical: "Hierarchical",
  typed_facts: "Typed-facts",
  spo_supersede: "SPO + supersede",
};

interface Row {
  approach: Approach;
  slice: Slice;
  n: number;
  hits: number;
  acc: number;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  embed_tokens: number;
  ingest_tokens_in: number;
  ingest_tokens_out: number;
  ingest_embed_tokens: number;
  distractor_k: number;
}

interface EconRow {
  approach: Approach;
  distractor_k: number;
  n: number;
  hits: number;
  acc: number;
  // Summed over all N questions of this (approach, K).
  retrieval_cost_usd: number;
  ingest_cost_usd: number;
  // $ per correct answer — the bench's headline economic number.
  dollars_per_correct: number;
  // Per-question averages.
  avg_retrieval_tokens: number;
  avg_ingest_tokens: number;
}

async function main() {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT approach, slice, distractor_k,
            COUNT(*) AS n,
            SUM(judge_score) AS hits,
            AVG(latency_ms) AS latency_ms,
            COALESCE(SUM(tokens_in), 0) AS tokens_in,
            COALESCE(SUM(tokens_out), 0) AS tokens_out,
            COALESCE(SUM(embed_tokens), 0) AS embed_tokens,
            COALESCE(SUM(ingest_tokens_in), 0) AS ingest_tokens_in,
            COALESCE(SUM(ingest_tokens_out), 0) AS ingest_tokens_out,
            COALESCE(SUM(ingest_embed_tokens), 0) AS ingest_embed_tokens
     FROM runs
     GROUP BY approach, slice, distractor_k
     ORDER BY approach, distractor_k, slice`,
  );
  const data = (rows as any[]).map<Row>((r) => ({
    approach: r.approach as Approach,
    slice: r.slice as Slice,
    distractor_k: Number(r.distractor_k ?? 0),
    n: Number(r.n),
    hits: Number(r.hits),
    acc: Number(r.n) > 0 ? Number(r.hits) / Number(r.n) : 0,
    latency_ms: Math.round(Number(r.latency_ms ?? 0)),
    tokens_in: Number(r.tokens_in ?? 0),
    tokens_out: Number(r.tokens_out ?? 0),
    embed_tokens: Number(r.embed_tokens ?? 0),
    ingest_tokens_in: Number(r.ingest_tokens_in ?? 0),
    ingest_tokens_out: Number(r.ingest_tokens_out ?? 0),
    ingest_embed_tokens: Number(r.ingest_embed_tokens ?? 0),
  }));

  if (data.length === 0) {
    console.log(
      "No runs yet. Start a bench first (`bun run bench`) and rerun this.",
    );
    await pool.end();
    return;
  }

  const overall = overallByApproach(data);
  const econ = economicsByApproach(data);

  printStdoutTable(data);
  console.log();
  printAsciiBars(data);
  console.log();
  printOverall(overall);
  console.log();
  printEconomics(econ);
  console.log();
  printDistractorCurve(data);

  const md = toMarkdown(data, overall, econ);
  console.log("\n=== Markdown (paste into deck) ===\n");
  console.log(md);

  const outDir = path.join(import.meta.dir, "..", "results");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const mdPath = path.join(outDir, `summary-${stamp}.md`);
  fs.writeFileSync(mdPath, md);
  console.log(`\nWrote ${mdPath}`);

  await pool.end();
}

function overallByApproach(
  data: Row[],
): Record<Approach, { n: number; hits: number; acc: number }> {
  const o: Record<string, { n: number; hits: number; acc: number }> = {};
  for (const r of data) {
    o[r.approach] ??= { n: 0, hits: 0, acc: 0 };
    o[r.approach]!.n += r.n;
    o[r.approach]!.hits += r.hits;
  }
  for (const a of Object.keys(o)) {
    o[a]!.acc = o[a]!.n > 0 ? o[a]!.hits / o[a]!.n : 0;
  }
  return o as Record<Approach, { n: number; hits: number; acc: number }>;
}

function printStdoutTable(data: Row[]) {
  const sliceSet = [...TARGET_SLICES];
  const bySlice: Record<string, Record<string, Row>> = {};
  for (const r of data) {
    bySlice[r.approach] ??= {};
    bySlice[r.approach]![r.slice] = r;
  }

  const header = ["approach", ...sliceSet, "overall"];
  const widths = header.map((h) => h.length);
  const lines: string[][] = [];
  for (const a of APPROACH_ORDER) {
    if (!bySlice[a]) continue;
    const row: string[] = [APPROACH_LABEL[a]];
    let totalN = 0;
    let totalH = 0;
    for (const s of sliceSet) {
      const r = bySlice[a]![s];
      if (r) {
        row.push(`${pct(r.acc)} (${r.hits}/${r.n})`);
        totalN += r.n;
        totalH += r.hits;
      } else {
        row.push("—");
      }
    }
    row.push(
      totalN > 0 ? `${pct(totalH / totalN)} (${totalH}/${totalN})` : "—",
    );
    lines.push(row);
  }
  for (const row of lines)
    row.forEach((c, i) => (widths[i] = Math.max(widths[i]!, c.length)));
  header.forEach((h, i) => (widths[i] = Math.max(widths[i]!, h.length)));
  const fmt = (row: string[]) =>
    row.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  const rule = widths.map((w) => "─".repeat(w)).join("──");
  console.log(fmt(header));
  console.log(rule);
  for (const r of lines) console.log(fmt(r));
}

function printAsciiBars(data: Row[]) {
  const bySlice: Record<string, Row[]> = {};
  for (const r of data) {
    bySlice[r.slice] ??= [];
    bySlice[r.slice]!.push(r);
  }
  for (const s of TARGET_SLICES) {
    const rows = bySlice[s];
    if (!rows) continue;
    console.log(`slice: ${s}`);
    for (const a of APPROACH_ORDER) {
      const r = rows.find((x) => x.approach === a);
      if (!r) continue;
      const w = Math.round(r.acc * 40);
      const bar = "█".repeat(w) + "·".repeat(40 - w);
      const label = APPROACH_LABEL[a].padEnd(22);
      console.log(`  ${label} ${bar}  ${pct(r.acc)}`);
    }
    console.log();
  }
}

function printOverall(
  overall: Record<Approach, { n: number; hits: number; acc: number }>,
) {
  console.log("overall (all slices combined):");
  const rows = APPROACH_ORDER.filter((a) => overall[a]);
  const max = Math.max(...rows.map((a) => overall[a]!.acc), 0.01);
  for (const a of rows) {
    const o = overall[a]!;
    const w = Math.round((o.acc / max) * 40);
    const bar = "█".repeat(w) + "·".repeat(40 - w);
    const label = APPROACH_LABEL[a].padEnd(22);
    console.log(`  ${label} ${bar}  ${pct(o.acc)} (${o.hits}/${o.n})`);
  }
}

function economicsByApproach(data: Row[]): EconRow[] {
  // Group by (approach, distractor_k) — accuracy means nothing without
  // knowing which noise level it was measured at.
  const bucket = new Map<string, EconRow>();
  for (const r of data) {
    const key = `${r.approach}:${r.distractor_k}`;
    let e = bucket.get(key);
    if (!e) {
      e = {
        approach: r.approach,
        distractor_k: r.distractor_k,
        n: 0,
        hits: 0,
        acc: 0,
        retrieval_cost_usd: 0,
        ingest_cost_usd: 0,
        dollars_per_correct: 0,
        avg_retrieval_tokens: 0,
        avg_ingest_tokens: 0,
      };
      bucket.set(key, e);
    }
    e.n += r.n;
    e.hits += r.hits;
    e.retrieval_cost_usd += costFromFlat(
      r.tokens_in,
      r.tokens_out,
      r.embed_tokens,
      { chatModel: ANSWER_MODEL, embedModel: EMBED_MODEL },
    );
    // Ingest mixes write-model calls (Flash-lite) with composer calls (Pro)
    // for spo_supersede. We can't split here without per-model columns,
    // so we blend: attribute ~85% of chat tokens to WRITE_MODEL and ~15% to
    // COMPOSE_MODEL (empirically close for the 5-lens pipeline). Crude, but
    // better than flat-priced-as-flash and directionally right for the Pareto.
    const composerShare = r.approach === "spo_supersede" ? 0.15 : 0;
    const writeIn = r.ingest_tokens_in * (1 - composerShare);
    const writeOut = r.ingest_tokens_out * (1 - composerShare);
    const composeIn = r.ingest_tokens_in * composerShare;
    const composeOut = r.ingest_tokens_out * composerShare;
    e.ingest_cost_usd +=
      costFromFlat(writeIn, writeOut, r.ingest_embed_tokens, {
        chatModel: WRITE_MODEL,
        embedModel: EMBED_MODEL,
      }) + costFromFlat(composeIn, composeOut, 0, { chatModel: COMPOSE_MODEL });
  }
  const out = Array.from(bucket.values());
  for (const e of out) {
    e.acc = e.n > 0 ? e.hits / e.n : 0;
    e.dollars_per_correct =
      e.hits > 0
        ? (e.retrieval_cost_usd + e.ingest_cost_usd) / e.hits
        : Number.POSITIVE_INFINITY;
    // N questions went through the retrieval path once each, but ingest
    // stats are written once per outcome (one row per approach per question),
    // so the N denominator is consistent.
    e.avg_retrieval_tokens = e.n > 0 ? costSumTokens(data, e, "retrieval") : 0;
    e.avg_ingest_tokens = e.n > 0 ? costSumTokens(data, e, "ingest") : 0;
  }
  out.sort(
    (a, b) =>
      a.distractor_k - b.distractor_k ||
      APPROACH_ORDER.indexOf(a.approach) - APPROACH_ORDER.indexOf(b.approach),
  );
  return out;
}

function costSumTokens(
  data: Row[],
  e: EconRow,
  kind: "retrieval" | "ingest",
): number {
  let tokens = 0;
  let n = 0;
  for (const r of data) {
    if (r.approach !== e.approach || r.distractor_k !== e.distractor_k)
      continue;
    n += r.n;
    if (kind === "retrieval") {
      tokens += r.tokens_in + r.tokens_out + r.embed_tokens;
    } else {
      tokens +=
        r.ingest_tokens_in + r.ingest_tokens_out + r.ingest_embed_tokens;
    }
  }
  return n > 0 ? Math.round(tokens / n) : 0;
}

function printEconomics(econ: EconRow[]): void {
  if (econ.length === 0) return;
  console.log("economics ($/correct answer — lower is better):");
  const byK: Record<number, EconRow[]> = {};
  for (const e of econ) (byK[e.distractor_k] ??= []).push(e);

  for (const kStr of Object.keys(byK).sort((a, b) => Number(a) - Number(b))) {
    const k = Number(kStr);
    console.log(`  distractor_k = ${k}`);
    const rows = byK[k]!;
    const header = [
      "approach",
      "acc",
      "retr$",
      "ingest$",
      "$/correct",
      "avg-retr-tok",
      "avg-ingest-tok",
    ];
    const fmtRow = (e: EconRow): string[] => [
      APPROACH_LABEL[e.approach],
      `${pct(e.acc)} (${e.hits}/${e.n})`,
      `$${e.retrieval_cost_usd.toFixed(4)}`,
      `$${e.ingest_cost_usd.toFixed(4)}`,
      Number.isFinite(e.dollars_per_correct)
        ? `$${e.dollars_per_correct.toFixed(4)}`
        : "—",
      String(e.avg_retrieval_tokens),
      String(e.avg_ingest_tokens),
    ];
    const body = rows
      .sort(
        (a, b) =>
          APPROACH_ORDER.indexOf(a.approach) -
          APPROACH_ORDER.indexOf(b.approach),
      )
      .map(fmtRow);
    const widths = header.map((h, i) =>
      Math.max(h.length, ...body.map((r) => r[i]!.length)),
    );
    const fmt = (r: string[]) =>
      r.map((c, i) => c.padEnd(widths[i]!)).join("  ");
    console.log("    " + fmt(header));
    console.log("    " + widths.map((w) => "─".repeat(w)).join("──"));
    for (const r of body) console.log("    " + fmt(r));
  }
}

function printDistractorCurve(data: Row[]): void {
  const ks = Array.from(new Set(data.map((r) => r.distractor_k))).sort(
    (a, b) => a - b,
  );
  if (ks.length <= 1) {
    // No distractor runs yet; the curve is degenerate — skip.
    return;
  }
  console.log("distractor-robustness (accuracy vs K, averaged across slices):");
  // Build accuracy table: approach × K.
  const acc: Record<
    Approach,
    Record<number, { n: number; hits: number }>
  > = {} as any;
  for (const r of data) {
    acc[r.approach] ??= {};
    acc[r.approach]![r.distractor_k] ??= { n: 0, hits: 0 };
    acc[r.approach]![r.distractor_k]!.n += r.n;
    acc[r.approach]![r.distractor_k]!.hits += r.hits;
  }
  const header = ["approach", ...ks.map((k) => `K=${k}`)];
  const rows: string[][] = [];
  for (const a of APPROACH_ORDER) {
    if (!acc[a]) continue;
    const row: string[] = [APPROACH_LABEL[a]];
    for (const k of ks) {
      const cell = acc[a]![k];
      row.push(cell && cell.n > 0 ? pct(cell.hits / cell.n) : "—");
    }
    rows.push(row);
  }
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]!.length)),
  );
  const fmt = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  console.log("  " + fmt(header));
  console.log("  " + widths.map((w) => "─".repeat(w)).join("──"));
  for (const r of rows) console.log("  " + fmt(r));
}

function toMarkdown(
  data: Row[],
  overall: Record<Approach, { n: number; hits: number; acc: number }>,
  econ: EconRow[],
): string {
  const bySlice: Record<string, Record<string, Row>> = {};
  for (const r of data) {
    bySlice[r.approach] ??= {};
    bySlice[r.approach]![r.slice] = r;
  }
  const headers = ["Approach", ...TARGET_SLICES, "Overall"];
  const lines: string[] = [];
  lines.push("### Accuracy");
  lines.push("");
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const a of APPROACH_ORDER) {
    if (!bySlice[a] && !overall[a]) continue;
    const cells: string[] = [
      a === "typed_facts" ? `**${APPROACH_LABEL[a]}**` : APPROACH_LABEL[a],
    ];
    for (const s of TARGET_SLICES) {
      const r = bySlice[a]?.[s];
      cells.push(r ? `${pct(r.acc)} (${r.hits}/${r.n})` : "—");
    }
    const o = overall[a];
    cells.push(o ? `${pct(o.acc)} (${o.hits}/${o.n})` : "—");
    lines.push(`| ${cells.join(" | ")} |`);
  }

  const byK: Record<number, EconRow[]> = {};
  for (const e of econ) (byK[e.distractor_k] ??= []).push(e);
  const ks = Object.keys(byK)
    .map(Number)
    .sort((a, b) => a - b);

  for (const k of ks) {
    lines.push("");
    lines.push(`### Economics (distractor_k = ${k})`);
    lines.push("");
    lines.push(
      "| Approach | Accuracy | Retrieval $ | Ingest $ | $/correct | Avg retr. tokens | Avg ingest tokens |",
    );
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    const rows = byK[k]!.sort(
      (a, b) =>
        APPROACH_ORDER.indexOf(a.approach) - APPROACH_ORDER.indexOf(b.approach),
    );
    for (const e of rows) {
      lines.push(
        `| ${APPROACH_LABEL[e.approach]} | ${pct(e.acc)} (${e.hits}/${e.n}) | $${e.retrieval_cost_usd.toFixed(4)} | $${e.ingest_cost_usd.toFixed(4)} | ${Number.isFinite(e.dollars_per_correct) ? `$${e.dollars_per_correct.toFixed(4)}` : "—"} | ${e.avg_retrieval_tokens} | ${e.avg_ingest_tokens} |`,
      );
    }
  }

  if (ks.length > 1) {
    lines.push("");
    lines.push("### Distractor-robustness (accuracy vs K)");
    lines.push("");
    lines.push(`| Approach | ${ks.map((k) => `K=${k}`).join(" | ")} |`);
    lines.push(`| --- | ${ks.map(() => "---").join(" | ")} |`);
    const byApproachK: Record<
      Approach,
      Record<number, { n: number; hits: number }>
    > = {} as any;
    for (const r of data) {
      byApproachK[r.approach] ??= {};
      byApproachK[r.approach]![r.distractor_k] ??= { n: 0, hits: 0 };
      byApproachK[r.approach]![r.distractor_k]!.n += r.n;
      byApproachK[r.approach]![r.distractor_k]!.hits += r.hits;
    }
    for (const a of APPROACH_ORDER) {
      if (!byApproachK[a]) continue;
      const cells = [APPROACH_LABEL[a]];
      for (const k of ks) {
        const c = byApproachK[a]![k];
        cells.push(c && c.n > 0 ? pct(c.hits / c.n) : "—");
      }
      lines.push(`| ${cells.join(" | ")} |`);
    }
  }

  return lines.join("\n");
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
