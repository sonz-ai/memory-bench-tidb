import { getPool, vecLiteral } from "../db/client.ts";
import { chatJSON, embed, WRITE_MODEL } from "../llm.ts";

/** Promote facts → summary once this many facts accumulate uncompressed. */
const FACT_TO_SUMMARY_THRESHOLD = 10;

/**
 * Sync consolidation: when an agent has >= N unconsolidated level-1 facts,
 * compress them into a level-2 summary and link via parent_id.
 *
 * Production Sonzai runs this async on a job queue; for the hackathon we do it
 * inline so the demo flow is observable without extra infra.
 */
export async function maybeConsolidate(agentId: string): Promise<void> {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT id, content, event_time, importance
     FROM memories
     WHERE approach = 'typed_facts'
       AND agent_id = ?
       AND level = 1
       AND parent_id IS NULL
     ORDER BY event_time ASC`,
    [agentId],
  );

  const facts = rows as Array<{
    id: string;
    content: string;
    event_time: Date;
    importance: number;
  }>;

  if (facts.length < FACT_TO_SUMMARY_THRESHOLD) return;

  const bullets = facts
    .map((f, i) => `${i + 1}. [${f.event_time.toISOString()}] ${f.content}`)
    .join("\n");

  const SYSTEM = `You compress a batch of atomic facts into ONE dense summary.
Output JSON: { "summary": string, "entities": string[], "importance": number in 0..1 }.
Rules: keep all proper nouns, all dates, all numbers. Drop only repetition. Importance = max of inputs, rounded.`;

  const result = await chatJSON<{
    summary: string;
    entities: string[];
    importance: number;
  }>(WRITE_MODEL, SYSTEM, bullets);

  const span_start = facts[0]!.event_time;
  const span_end = facts[facts.length - 1]!.event_time;
  const mid = new Date((span_start.getTime() + span_end.getTime()) / 2);
  const [summaryEmb] = await embed([result.summary]);

  const [insertResult] = await pool.query(
    `INSERT INTO memories (approach, agent_id, level, content, event_time, importance, entities, embedding)
     VALUES ('typed_facts', ?, 2, ?, ?, ?, ?, ?)`,
    [
      agentId,
      result.summary,
      mid,
      Math.max(0, Math.min(1, Number(result.importance) || 0.6)),
      JSON.stringify(result.entities ?? []),
      vecLiteral(summaryEmb),
    ],
  );
  const summaryId = (insertResult as any).insertId;

  // Link facts to parent summary so we can walk the tree later.
  const factIds = facts.map((f) => f.id);
  await pool.query(
    `UPDATE memories SET parent_id = ? WHERE id IN (${factIds.map(() => "?").join(",")})`,
    [summaryId, ...factIds],
  );
}
