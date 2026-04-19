// Eval-only run: skip ingest, use balancedSubset to figure out which agents
// we SHOULD have and eval only those that actually have memories in DB.
import { getPool } from "../src/db/client.ts";
import { APPROACHES, retrieve } from "../src/dispatch.ts";
import { answerFromRetrieved, judge } from "../src/eval/answer.ts";
import {
  balancedSubset,
  loadLongMemEvalOracle,
  parseLMEDate,
  sliceOf,
} from "../src/eval/fixtures.ts";

const pool = getPool();
const [rows]: any = await pool.query(
  "SELECT DISTINCT agent_id FROM memories",
);
const ingested = new Set<string>(rows.map((r: any) => r.agent_id));
console.log(`Found ${ingested.size} ingested agents in DB.`);

const subset = balancedSubset(loadLongMemEvalOracle(), 3).filter((q) =>
  ingested.has(q.question_id),
);
console.log(`Evaluating ${subset.length} questions (the ingested ones).`);

await pool.query("DELETE FROM runs");

for (const q of subset) {
  const slice = sliceOf(q);
  if (!slice) continue;
  const qdate = parseLMEDate(q.question_date);
  for (const approach of APPROACHES) {
    const t0 = Date.now();
    const retrieved = await retrieve(approach, q.question_id, q.question, qdate, 5);
    const predicted = await answerFromRetrieved(q.question, qdate, retrieved);
    const latency_ms = Date.now() - t0;
    const j = await judge(q.question, q.answer, predicted);
    await pool.query(
      `INSERT INTO runs (approach, slice, question_id, question, gold_answer, predicted_answer, retrieved_ids, judge_score, judge_rationale, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        approach,
        slice,
        q.question_id,
        q.question,
        q.answer,
        predicted,
        JSON.stringify(retrieved.map((r) => r.memory.content)),
        j.score,
        j.rationale,
        latency_ms,
      ],
    );
    console.log(`[${approach}] ${slice.padEnd(18)} ${j.score ? "✓" : "✗"}  ${q.question.slice(0, 60)}`);
  }
}

await pool.end();
console.log("Done.");
