import { getPool, vecLiteral } from "../db/client.ts";
import { chatText, embed, WRITE_MODEL } from "../llm.ts";
import type { RetrievalResult, Turn } from "../types.ts";

/**
 * Baseline 3 — hierarchical (recent verbatim + older summarized).
 *
 * Writes raw turns always. Once raw count exceeds RECENT_WINDOW, oldest raw
 * turns beyond the window are consolidated into a summary and the raw copies
 * deleted. Retrieval searches BOTH layers (recent raw + older summaries) and
 * blends by vector similarity.
 *
 * This is the "smarter vector RAG" approach — still missing temporal,
 * importance, and entity reasoning.
 */
const APPROACH = "hierarchical";
const RECENT_WINDOW = 20;
const COMPRESS_CHUNK = 10;

export async function writeHierarchical(
  agentId: string,
  turn: Turn,
): Promise<void> {
  const [emb] = await embed([turn.content]);
  await getPool().query(
    `INSERT INTO memories (approach, agent_id, level, content, event_time, importance, entities, embedding)
     VALUES (?, ?, 0, ?, ?, 0.5, JSON_ARRAY(), ?)`,
    [APPROACH, agentId, turn.content, turn.timestamp, vecLiteral(emb)],
  );

  const [[row]] = (await getPool().query(
    `SELECT COUNT(*) AS n FROM memories WHERE approach = ? AND agent_id = ? AND level = 0`,
    [APPROACH, agentId],
  )) as any;
  if (Number(row.n) > RECENT_WINDOW) {
    await compressOldest(agentId);
  }
}

async function compressOldest(agentId: string): Promise<void> {
  const [rows] = await getPool().query(
    `SELECT id, content, event_time FROM memories
     WHERE approach = ? AND agent_id = ? AND level = 0
     ORDER BY event_time ASC LIMIT ?`,
    [APPROACH, agentId, COMPRESS_CHUNK],
  );
  const chunk = rows as any[];
  if (chunk.length === 0) return;

  const bullets = chunk
    .map((c) => `- [${new Date(c.event_time).toISOString()}] ${c.content}`)
    .join("\n");
  const summary = await chatText(
    WRITE_MODEL,
    "Summarize these turns in 3-5 sentences. Keep proper nouns, dates, numbers.",
    bullets,
  );
  const [emb] = await embed([summary]);
  const mid = new Date(
    (new Date(chunk[0].event_time).getTime() +
      new Date(chunk[chunk.length - 1].event_time).getTime()) /
      2,
  );

  await getPool().query(
    `INSERT INTO memories (approach, agent_id, level, content, event_time, importance, entities, embedding)
     VALUES (?, ?, 2, ?, ?, 0.5, JSON_ARRAY(), ?)`,
    [APPROACH, agentId, summary, mid, vecLiteral(emb)],
  );
  const ids = chunk.map((c) => c.id);
  await getPool().query(
    `DELETE FROM memories WHERE id IN (${ids.map(() => "?").join(",")})`,
    ids,
  );
}

export async function retrieveHierarchical(
  agentId: string,
  question: string,
  topK = 5,
): Promise<RetrievalResult[]> {
  const [qe] = await embed([question]);
  const [rows] = await getPool().query(
    `SELECT content, level, event_time, (1 - VEC_COSINE_DISTANCE(embedding, ?)) AS score
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
      level: r.level,
      content: r.content,
      event_time: new Date(r.event_time),
      importance: 0.5,
      entities: [],
    },
    score: Number(r.score),
  }));
}
