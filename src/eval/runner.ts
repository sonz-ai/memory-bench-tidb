import { getPool } from "../db/client.ts";
import { APPROACHES, flush, retrieve, write } from "../dispatch.ts";
import { withTokenScope } from "../llm.ts";
import type { Approach } from "../types.ts";
import { answerFromRetrieved, judge } from "./answer.ts";
import {
  balancedSubset,
  flattenHaystack,
  injectDistractors,
  loadLongMemEvalOracle,
  parseLMEDate,
  sliceOf,
  type LMEQuestion,
  type Slice,
} from "./fixtures.ts";

export interface RunConfig {
  perSlice: number;
  approaches: Approach[];
  skipIngest?: boolean;
  /**
   * Distractor-robustness knob. K irrelevant turns (pulled from other
   * questions' haystacks) are injected into each question's ingest stream
   * to stress-test retrieval under noise. 0 = clean baseline.
   */
  distractorK?: number;
}

export interface RunOutcome {
  approach: Approach;
  slice: Slice;
  question_id: string;
  question: string;
  gold: string;
  predicted: string;
  score: 0 | 1;
  rationale: string;
  latency_ms: number;
  retrieved: string[];
  // Economics: retrieval+answer tokens (judge excluded — that's grader cost).
  tokens_in: number;
  tokens_out: number;
  embed_tokens: number;
  // Ingest tokens attributed to this (approach, question_id). All questions
  // evaluated against the same ingest share its total (1:1 here: one
  // question per agent_id).
  ingest_tokens_in: number;
  ingest_tokens_out: number;
  ingest_embed_tokens: number;
  ingest_latency_ms: number;
  // Robustness label so we can group by K at summary time.
  distractor_k: number;
}

interface IngestStats {
  tokens_in: number;
  tokens_out: number;
  embed_tokens: number;
  latency_ms: number;
}

/**
 * Concurrency knobs (env-configurable):
 *
 *   INGEST_CONCURRENCY  - how many questions ingest in parallel (default 2).
 *                         Questions are isolated by agent_id so there's no
 *                         cross-contamination; the cap is LLM rate limits.
 *   EVAL_CONCURRENCY    - how many questions evaluate in parallel (default 4).
 *                         Each in-flight question also fans out across all
 *                         approaches, so true concurrent LLM calls is
 *                         EVAL_CONCURRENCY * approaches.length * 2 (answer + judge).
 *
 * Bump INGEST_CONCURRENCY up if you have rate headroom; drop it to 1 if
 * you're seeing 429s.
 */
const INGEST_CONCURRENCY = parseInt(process.env.INGEST_CONCURRENCY ?? "2", 10);
const EVAL_CONCURRENCY = parseInt(process.env.EVAL_CONCURRENCY ?? "4", 10);

export async function runBench(cfg: RunConfig): Promise<RunOutcome[]> {
  const distractorK = cfg.distractorK ?? 0;
  const all = loadLongMemEvalOracle();
  const subset = balancedSubset(all, cfg.perSlice);
  console.log(
    `Loaded ${all.length} LME questions; running balanced subset of ${subset.length}.`,
  );
  console.log(
    `Concurrency: ingest=${INGEST_CONCURRENCY}, eval=${EVAL_CONCURRENCY}, approaches=${cfg.approaches.length}`,
  );
  if (distractorK > 0) {
    console.log(
      `Distractor-robustness: injecting K=${distractorK} irrelevant turns per question.`,
    );
  }

  // Keyed by `${approach}:${question_id}` — populated during ingest, read
  // back during eval so we can attribute ingest spend per row in runs.
  const ingestStatsByAgent = new Map<string, IngestStats>();

  if (!cfg.skipIngest) {
    await clearOldRuns();
    const ingestStart = Date.now();
    let done = 0;
    await runPool(subset, INGEST_CONCURRENCY, async (q, qi) => {
      const turns =
        distractorK > 0
          ? injectDistractors(q, all, distractorK)
          : flattenHaystack(q);
      const t0 = Date.now();
      console.log(
        `[ingest ${qi + 1}/${subset.length}] ${q.question_id} (${q.question_type}) ${turns.length} turns × ${cfg.approaches.length} approaches`,
      );
      // Approaches are independent — different approach tags in the same row set.
      const perApproach = await Promise.all(
        cfg.approaches.map(async (approach) => {
          const started = Date.now();
          const { tally } = await withTokenScope(() =>
            ingestForQuestion(approach, q, turns),
          );
          return {
            approach,
            stats: {
              tokens_in: tally.prompt_tokens,
              tokens_out: tally.completion_tokens,
              embed_tokens: tally.embed_tokens,
              latency_ms: Date.now() - started,
            } as IngestStats,
          };
        }),
      );
      for (const { approach, stats } of perApproach) {
        ingestStatsByAgent.set(`${approach}:${q.question_id}`, stats);
      }
      done += 1;
      console.log(
        `  ↳ [${done}/${subset.length}] ${q.question_id} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
    });
    console.log(
      `\nIngest complete in ${((Date.now() - ingestStart) / 1000).toFixed(1)}s\n`,
    );
  }

  const outcomes: RunOutcome[] = [];
  const evalStart = Date.now();
  let evalDone = 0;

  await runPool(subset, EVAL_CONCURRENCY, async (q) => {
    const slice = sliceOf(q);
    if (!slice) return;
    const qdate = parseLMEDate(q.question_date);

    // Per-question: run all approaches in parallel. Each approach's
    // retrieve → answer → judge chain is serial, but the three chains across
    // different approaches overlap fully.
    const perApproach = await Promise.all(
      cfg.approaches.map(async (approach) => {
        const t0 = Date.now();
        // Scope retrieval + answer — judge is grader cost, not approach cost.
        const { value, tally } = await withTokenScope(async () => {
          const retrieved = await retrieve(
            approach,
            q.question_id,
            q.question,
            qdate,
            5,
          );
          const predicted = await answerFromRetrieved(
            q.question,
            qdate,
            retrieved,
          );
          return { retrieved, predicted };
        });
        const latency_ms = Date.now() - t0;
        const j = await judge(q.question, q.answer, value.predicted);

        const ingest = ingestStatsByAgent.get(
          `${approach}:${q.question_id}`,
        ) ?? {
          tokens_in: 0,
          tokens_out: 0,
          embed_tokens: 0,
          latency_ms: 0,
        };

        const outcome: RunOutcome = {
          approach,
          slice,
          question_id: q.question_id,
          question: q.question,
          gold: q.answer,
          predicted: value.predicted,
          score: j.score,
          rationale: j.rationale,
          latency_ms,
          retrieved: value.retrieved.map((r) => r.memory.content),
          tokens_in: tally.prompt_tokens,
          tokens_out: tally.completion_tokens,
          embed_tokens: tally.embed_tokens,
          ingest_tokens_in: ingest.tokens_in,
          ingest_tokens_out: ingest.tokens_out,
          ingest_embed_tokens: ingest.embed_tokens,
          ingest_latency_ms: ingest.latency_ms,
          distractor_k: distractorK,
        };
        await persistOutcome(outcome);
        return outcome;
      }),
    );

    outcomes.push(...perApproach);
    evalDone += 1;
    const perApproachLog = perApproach
      .map((o) => `${o.approach.slice(0, 8)}:${o.score ? "✓" : "✗"}`)
      .join(" ");
    console.log(
      `[eval ${evalDone}/${subset.length}] ${slice.padEnd(18)} ${perApproachLog}  ${q.question.slice(0, 50)}`,
    );
  });

  console.log(
    `\nEval complete in ${((Date.now() - evalStart) / 1000).toFixed(1)}s`,
  );
  return outcomes;
}

/**
 * Bounded-concurrency pool. Runs `fn` over `items` with at most
 * `concurrency` promises in flight. Fn receives (item, index).
 */
async function runPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (true) {
        const i = idx++;
        if (i >= items.length) return;
        await fn(items[i]!, i);
      }
    },
  );
  await Promise.all(workers);
}

async function ingestForQuestion(
  approach: Approach,
  q: LMEQuestion,
  turns: Array<{
    role: "user" | "assistant";
    content: string;
    timestamp: Date;
  }>,
): Promise<void> {
  for (const t of turns) {
    await write(approach, q.question_id, {
      role: t.role,
      content: t.content,
      timestamp: t.timestamp,
    });
  }
  await flush(approach, q.question_id);
}

async function clearOldRuns(): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM memories`);
  await pool.query(`DELETE FROM runs`);
}

async function persistOutcome(o: RunOutcome): Promise<void> {
  await getPool().query(
    `INSERT INTO runs (
       approach, slice, question_id, question, gold_answer, predicted_answer,
       retrieved_ids, judge_score, judge_rationale, latency_ms,
       tokens_in, tokens_out, embed_tokens,
       ingest_tokens_in, ingest_tokens_out, ingest_embed_tokens, ingest_latency_ms,
       distractor_k
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      o.approach,
      o.slice,
      o.question_id,
      o.question,
      o.gold,
      o.predicted,
      JSON.stringify(o.retrieved),
      o.score,
      o.rationale,
      o.latency_ms,
      o.tokens_in,
      o.tokens_out,
      o.embed_tokens,
      o.ingest_tokens_in,
      o.ingest_tokens_out,
      o.ingest_embed_tokens,
      o.ingest_latency_ms,
      o.distractor_k,
    ],
  );
}

export function summarize(
  outcomes: RunOutcome[],
): Record<string, Record<string, { n: number; acc: number }>> {
  const out: Record<string, Record<string, { n: number; acc: number }>> = {};
  for (const o of outcomes) {
    out[o.approach] ??= {};
    out[o.approach]![o.slice] ??= { n: 0, acc: 0 };
    out[o.approach]![o.slice]!.n += 1;
    out[o.approach]![o.slice]!.acc += o.score;
  }
  for (const a of Object.keys(out)) {
    for (const s of Object.keys(out[a]!)) {
      out[a]![s]!.acc = out[a]![s]!.acc / Math.max(1, out[a]![s]!.n);
    }
  }
  return out;
}

if (import.meta.main) {
  const perSlice = parseInt(process.env.PER_SLICE ?? "10", 10);
  const distractorK = parseInt(process.env.DISTRACTOR_K ?? "0", 10);
  const onlyApproaches = process.env.APPROACHES?.split(",").filter(Boolean) as
    | Approach[]
    | undefined;
  runBench({
    perSlice,
    approaches: onlyApproaches ?? APPROACHES,
    distractorK,
  })
    .then((out) => {
      const summary = summarize(out);
      console.log("\n=== Summary (accuracy by slice) ===");
      console.table(summary);
      return getPool().end();
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
