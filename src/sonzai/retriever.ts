import { getPool, vecLiteral } from "../db/client.ts";
import { embed } from "../llm.ts";
import type { RetrievalResult } from "../types.ts";
import { parseQuery } from "./query_parse.ts";

const DECAY_LAMBDA = 0.005; // per day. Half-life ~ 140 days. Low-importance facts decay faster in the blend.

export interface SonzaiRetrieveOpts {
  agentId: string;
  question: string;
  questionDate: Date;
  topK?: number;
}

/**
 * Hybrid retrieval — the single SQL statement that captures Sonzai's differentiation.
 *
 * Score = (
 *     w_vec * cosine_sim
 *   + w_lex * lexical_overlap
 *   + w_imp * importance
 * ) * exp(-lambda * age_days)
 *   * (1 + entity_match_bonus)
 *   * (1 if inside temporal window else 0.25)
 *
 * Retrieval searches over level-1 (facts) and level-2 (summaries). Level-0 raw
 * turns are provenance only — we don't score against them.
 */
export async function retrieveSonzai(
  opts: SonzaiRetrieveOpts,
): Promise<RetrievalResult[]> {
  const topK = opts.topK ?? 5;
  const parsed = await parseQuery(opts.question, opts.questionDate);

  const [hydeEmb] = await embed([parsed.hyde]);
  const pool = getPool();

  // Entity overlap becomes a SOFT boost (applied in ORDER BY), not a hard WHERE.
  // Because retrieval is already scoped by agent_id, an entity-miss would prune
  // legitimate context (e.g. synonym differences, or the parser extracting a
  // narrower noun than the stored entity). Soft-boost keeps recall + rewards
  // matches. When no entities are parsed, the boost is a no-op.
  const entityBoostSql =
    parsed.entities.length > 0
      ? `(CASE WHEN ${parsed.entities.map(() => "JSON_CONTAINS(entities, ?)").join(" OR ")} THEN 1.25 ELSE 1.0 END)`
      : `1.0`;
  const entityParams = parsed.entities.map((e) => JSON.stringify(e));

  // Temporal filter is a soft boost, not a hard cut, so a wrong parse doesn't
  // destroy recall. Hard cut would be the "clean" answer but is brittle.
  const timeStart = parsed.time_start ? new Date(parsed.time_start) : null;
  const timeEnd = parsed.time_end ? new Date(parsed.time_end) : null;

  const vecLit = vecLiteral(hydeEmb);

  // Keyword LIKE term — cheap lexical signal, works whether or not FTS index exists.
  const kwPattern =
    parsed.keywords.length > 0 ? "%" + parsed.keywords.join("%") + "%" : "%";

  // Retrieve over facts + summaries + raw turns. Level 0 (raw) keeps original
  // wording that atomic facts sometimes compress away — important for
  // single-session questions where the judge scores on verbatim specificity.
  // We downweight level 0 with a per-level boost so facts still rank higher
  // when they exist, but level 0 is available when facts are thin.
  const sql = `
    SELECT
      id, level, content, event_time, importance, entities,
      (1 - VEC_COSINE_DISTANCE(embedding, ?)) AS vec_sim,
      (CASE WHEN LOWER(content) LIKE ? THEN 1.0 ELSE 0.0 END) AS lex_hit,
      DATEDIFF(?, event_time) AS age_days,
      (CASE WHEN ? IS NULL OR ? IS NULL
            OR (event_time BETWEEN ? AND ?) THEN 1.0 ELSE 0.25 END) AS time_match
    FROM memories
    WHERE approach = 'typed_facts'
      AND agent_id = ?
    ORDER BY (
      (0.55 * (1 - VEC_COSINE_DISTANCE(embedding, ?))
       + 0.20 * (CASE WHEN LOWER(content) LIKE ? THEN 1.0 ELSE 0.0 END)
       + 0.25 * importance)
      * EXP(-${DECAY_LAMBDA} * GREATEST(0, DATEDIFF(?, event_time)))
      * (CASE WHEN ? IS NULL OR ? IS NULL
              OR (event_time BETWEEN ? AND ?) THEN 1.0 ELSE 0.25 END)
      * ${entityBoostSql}
      * (CASE level WHEN 0 THEN 0.85 WHEN 1 THEN 1.0 WHEN 2 THEN 1.05 ELSE 1.0 END)
    ) DESC
    LIMIT ?
  `;

  const qdate = opts.questionDate;
  const params: any[] = [
    vecLit, // SELECT vec_sim
    kwPattern.toLowerCase(), // SELECT lex_hit
    qdate, // SELECT age_days
    timeStart,
    timeEnd,
    timeStart,
    timeEnd, // SELECT time_match
    opts.agentId,
    vecLit, // ORDER BY vec
    kwPattern.toLowerCase(), // ORDER BY lex
    qdate, // ORDER BY decay
    timeStart,
    timeEnd,
    timeStart,
    timeEnd, // ORDER BY time_match
    ...entityParams, // ORDER BY entity boost
    topK,
  ];

  const [rows] = await pool.query(sql, params);
  const results = rows as Array<any>;

  return results.map((r) => ({
    memory: {
      approach: "typed_facts",
      agent_id: opts.agentId,
      level: r.level,
      content: r.content,
      event_time: new Date(r.event_time),
      importance: Number(r.importance),
      entities: safeJsonArray(r.entities),
    },
    score: 0, // score isn't returned separately in this shape; ordering is authoritative
    components: {
      vector: Number(r.vec_sim),
      fulltext: Number(r.lex_hit),
      importance: Number(r.importance),
      recency: Number(r.age_days),
      temporal_match: Number(r.time_match) === 1.0,
    },
  }));
}

function safeJsonArray(x: unknown): string[] {
  if (Array.isArray(x)) return x as string[];
  if (typeof x === "string") {
    try {
      const parsed = JSON.parse(x);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}
