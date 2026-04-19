import { getPool, vecLiteral } from "../db/client.ts";
import { chatText, embed, WRITE_MODEL } from "../llm.ts";
import type { RetrievalResult, Turn } from "../types.ts";

/**
 * Baseline 2 — progressive summarization.
 *
 * Every N turns we summarize the batch into a running summary.
 * Only summaries are retrieved against; raw turns are dropped from retrieval.
 * Retrieval is pure vector over summary embeddings.
 *
 * This is what teams do when they hit context limits but haven't invested in
 * structured memory.
 */
const APPROACH = "progressive_summary";
const BATCH_SIZE = 5;

interface PendingTurn {
  content: string;
  event_time: Date;
}
const pending: Map<string, PendingTurn[]> = new Map();

export async function writeProgressiveSummary(
  agentId: string,
  turn: Turn,
): Promise<void> {
  const buf = pending.get(agentId) ?? [];
  buf.push({ content: turn.content, event_time: turn.timestamp });
  pending.set(agentId, buf);

  if (buf.length >= BATCH_SIZE) {
    await flush(agentId);
  }
}

export async function flushProgressiveSummary(agentId: string): Promise<void> {
  if ((pending.get(agentId)?.length ?? 0) > 0) await flush(agentId);
}

async function flush(agentId: string): Promise<void> {
  const buf = pending.get(agentId) ?? [];
  if (buf.length === 0) return;
  pending.set(agentId, []);

  const bullets = buf
    .map((t) => `- [${t.event_time.toISOString()}] ${t.content}`)
    .join("\n");
  const summary = await chatText(
    WRITE_MODEL,
    "Summarize these conversation turns in 3-5 sentences. Preserve all proper nouns, numbers, and dates.",
    bullets,
  );
  const [emb] = await embed([summary]);
  const mid = new Date(
    (buf[0]!.event_time.getTime() + buf[buf.length - 1]!.event_time.getTime()) /
      2,
  );

  await getPool().query(
    `INSERT INTO memories (approach, agent_id, level, content, event_time, importance, entities, embedding)
     VALUES (?, ?, 2, ?, ?, 0.5, JSON_ARRAY(), ?)`,
    [APPROACH, agentId, summary, mid, vecLiteral(emb)],
  );
}

export async function retrieveProgressiveSummary(
  agentId: string,
  question: string,
  topK = 5,
): Promise<RetrievalResult[]> {
  const [qe] = await embed([question]);
  const [rows] = await getPool().query(
    `SELECT content, event_time, (1 - VEC_COSINE_DISTANCE(embedding, ?)) AS score
     FROM memories
     WHERE approach = ? AND agent_id = ?
     ORDER BY VEC_COSINE_DISTANCE(embedding, ?) ASC
     LIMIT ?`,
    [vecLiteral(qe), APPROACH, agentId, vecLiteral(qe), topK],
  );
  return (rows as any[]).map((r) => ({
    memory: {
      approach: APPROACH,
      agent_id: agentId,
      level: 2,
      content: r.content,
      event_time: new Date(r.event_time),
      importance: 0.5,
      entities: [],
    },
    score: Number(r.score),
  }));
}
