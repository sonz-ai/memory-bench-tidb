import { getPool, vecLiteral } from "../db/client.ts";
import { embed } from "../llm.ts";
import type { RetrievalResult, Turn } from "../types.ts";

/**
 * Baseline 1 — raw + embedding + cosine similarity.
 *
 * The default most teams ship. Every turn gets chunked, embedded, and stored.
 * Retrieval is pure vector similarity. No temporal reasoning, no importance,
 * no entity index — the things that make Sonzai work are all absent here.
 */
const APPROACH = "raw_vector";

export async function writeRawVector(
  agentId: string,
  turn: Turn,
): Promise<void> {
  const [emb] = await embed([turn.content]);
  await getPool().query(
    `INSERT INTO memories (approach, agent_id, level, content, event_time, importance, entities, embedding)
     VALUES (?, ?, 0, ?, ?, 0.5, JSON_ARRAY(), ?)`,
    [APPROACH, agentId, turn.content, turn.timestamp, vecLiteral(emb)],
  );
}

export async function retrieveRawVector(
  agentId: string,
  question: string,
  topK = 5,
): Promise<RetrievalResult[]> {
  const [qe] = await embed([question]);
  const [rows] = await getPool().query(
    `SELECT id, content, event_time, (1 - VEC_COSINE_DISTANCE(embedding, ?)) AS score
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
      level: 0,
      content: r.content,
      event_time: new Date(r.event_time),
      importance: 0.5,
      entities: [],
    },
    score: Number(r.score),
    components: { vector: Number(r.score) },
  }));
}
