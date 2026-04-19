import { getPool, vecLiteral } from "../db/client.ts";
import { embed } from "../llm.ts";
import type { RetrievalResult } from "../types.ts";
import { parseQuery } from "./query_parse.ts";

const DECAY_LAMBDA = 0.005; // per day
const APPROACH = "spo_supersede";

/**
 * 5-lens retriever.
 *
 * Same hybrid shape as the original typed_facts retriever but adds:
 *   - alive filter: superseded_at IS NULL so contradicted facts never surface
 *   - SPO-aware: a subject or object match gets an additional boost
 *   - "first / after" ordering: when the parser detects an ordering hint
 *     (first X after Y), we switch from importance-scored to event_time ASC
 *     within the temporal window.
 */
export async function retrieveSonzai5Lens(opts: {
  agentId: string;
  question: string;
  questionDate: Date;
  topK?: number;
}): Promise<RetrievalResult[]> {
  const topK = opts.topK ?? 5;
  const parsed = await parseQuery(opts.question, opts.questionDate);

  const [hydeEmb] = await embed([parsed.hyde]);
  const pool = getPool();

  const entityParams = parsed.entities.map((e) => e);
  const entityBoostSql =
    parsed.entities.length > 0
      ? `(CASE
           WHEN ${parsed.entities.map(() => "LOWER(subject) = ? OR LOWER(object) = ?").join(" OR ")}
           THEN 1.35
           WHEN ${parsed.entities.map(() => "JSON_CONTAINS(entities, JSON_QUOTE(?))").join(" OR ")}
           THEN 1.15
           ELSE 1.0
         END)`
      : "1.0";

  const timeStart = parsed.time_start ? new Date(parsed.time_start) : null;
  const timeEnd = parsed.time_end ? new Date(parsed.time_end) : null;
  const isOrderingQuery = looksLikeOrdering(opts.question);

  const vecLit = vecLiteral(hydeEmb);
  const kwPattern =
    parsed.keywords.length > 0 ? "%" + parsed.keywords.join("%") + "%" : "%";

  // Ordering branch: "first X after Y" — we want the chronologically earliest
  // match inside the window, not the most semantically relevant. Shortlist by
  // semantic + importance, then rank by event_time ASC.
  if (isOrderingQuery && timeStart) {
    const sql = `
      SELECT id, level, content, event_time, importance, entities, lens, subject, predicate, object,
             (1 - VEC_COSINE_DISTANCE(embedding, ?)) AS vec_sim
      FROM memories
      WHERE approach = ?
        AND agent_id = ?
        AND superseded_at IS NULL
        AND (event_time >= ? OR ? IS NULL)
      ORDER BY event_time ASC,
               (0.6 * (1 - VEC_COSINE_DISTANCE(embedding, ?)) + 0.4 * importance) DESC
      LIMIT ?
    `;
    const params: any[] = [
      vecLit,
      APPROACH,
      opts.agentId,
      timeStart,
      timeStart,
      vecLit,
      topK,
    ];
    const [rows] = await pool.query(sql, params);
    return shape(rows as any[], opts.agentId);
  }

  // Default branch: hybrid scored.
  const sql = `
    SELECT id, level, content, event_time, importance, entities, lens, subject, predicate, object,
      (1 - VEC_COSINE_DISTANCE(embedding, ?)) AS vec_sim,
      (CASE WHEN LOWER(content) LIKE ? THEN 1.0 ELSE 0.0 END) AS lex_hit,
      DATEDIFF(?, event_time) AS age_days,
      (CASE WHEN ? IS NULL OR ? IS NULL
            OR (event_time BETWEEN ? AND ?) THEN 1.0 ELSE 0.3 END) AS time_match
    FROM memories
    WHERE approach = ?
      AND agent_id = ?
      AND superseded_at IS NULL
    ORDER BY (
      (0.50 * (1 - VEC_COSINE_DISTANCE(embedding, ?))
       + 0.20 * (CASE WHEN LOWER(content) LIKE ? THEN 1.0 ELSE 0.0 END)
       + 0.30 * importance)
      * EXP(-${DECAY_LAMBDA} * GREATEST(0, DATEDIFF(?, event_time)))
      * (CASE WHEN ? IS NULL OR ? IS NULL
              OR (event_time BETWEEN ? AND ?) THEN 1.0 ELSE 0.3 END)
      * ${entityBoostSql}
      * (CASE level WHEN 0 THEN 0.80 WHEN 1 THEN 1.0 WHEN 2 THEN 1.05 ELSE 1.0 END)
    ) DESC
    LIMIT ?
  `;

  const qdate = opts.questionDate;
  const entityBoostParams =
    parsed.entities.length > 0
      ? [...entityParams.flatMap((e) => [e, e]), ...entityParams]
      : [];
  const params: any[] = [
    vecLit, // SELECT vec_sim
    kwPattern.toLowerCase(), // SELECT lex_hit
    qdate, // SELECT age_days
    timeStart,
    timeEnd,
    timeStart,
    timeEnd, // SELECT time_match
    APPROACH,
    opts.agentId,
    vecLit, // ORDER BY vec
    kwPattern.toLowerCase(), // ORDER BY lex
    qdate, // ORDER BY decay
    timeStart,
    timeEnd,
    timeStart,
    timeEnd, // ORDER BY time_match
    ...entityBoostParams,
    topK,
  ];

  const [rows] = await pool.query(sql, params);
  return shape(rows as any[], opts.agentId);
}

function looksLikeOrdering(q: string): boolean {
  const s = q.toLowerCase();
  return (
    /\bfirst\b.*\bafter\b/.test(s) ||
    /\bafter\b.*\bfirst\b/.test(s) ||
    /\bwhich (one|event|issue).*first\b/.test(s) ||
    /\bthe first\b/.test(s)
  );
}

function shape(rows: any[], agentId: string): RetrievalResult[] {
  return rows.map((r) => ({
    memory: {
      approach: "spo_supersede",
      agent_id: agentId,
      level: r.level,
      content: r.content,
      event_time: new Date(r.event_time),
      importance: Number(r.importance),
      entities: safeJsonArray(r.entities),
      subject: r.subject ?? null,
      predicate: r.predicate ?? null,
      object: r.object ?? null,
    },
    score: 0,
    components: {
      vector: Number(r.vec_sim ?? 0),
      importance: Number(r.importance),
    },
  }));
}

function safeJsonArray(x: unknown): string[] {
  if (Array.isArray(x)) return x as string[];
  if (typeof x === "string") {
    try {
      const p = JSON.parse(x);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}
