# Results (N=40, PER_SLICE=10)

Five memory architectures. One TiDB cluster. One `memories` table. One
hybrid-retrieval SQL statement. Only the `approach` column distinguishes
them. Gemini 3.1 Flash-Lite on both the agent and the judge.

| Approach | single_session | multi_session | temporal | knowledge_update | Overall |
|---|---|---|---|---|---|
| `raw_vector` | 30% | 30% | 70% | 60% | **47.5%** |
| `progressive_summary` | 0% | 10% | 70% | 80% | 40.0% |
| `hierarchical` | 30% | 10% | 40% | 80% | 40.0% |
| `typed_facts` | 10% | 10% | 20% | **90%** | 32.5% |
| `spo_supersede` | 0% | 0% | 0% | 30% | 7.5% |

Per-slice trade-offs are visible in the data: summarization trades
single_session accuracy for temporal and knowledge_update; SPO-deduped
atomic facts index the knowledge_update slice efficiently at the cost of
verbatim recall elsewhere; the more aggressive supersede policy
(`spo_supersede`) under-covers the answer-LLM's context window.

The point of the run isn't any single row. It's that **all five ran on
the same cluster, through the same retrieval path, reading and writing
the same schema**. A `WHERE approach = ?` change is the whole difference.

## What the bench did on TiDB

Every read, every approach, is this single statement:

```sql
SELECT id, content, event_time, importance,
       (1 - VEC_COSINE_DISTANCE(embedding, :q_vec)) AS vec_sim
FROM memories
WHERE approach = :strategy
  AND agent_id = :aid
  AND superseded_at IS NULL
ORDER BY (
    0.55 * (1 - VEC_COSINE_DISTANCE(embedding, :q_vec))   -- vector
  + 0.20 * (LOWER(content) LIKE :kw)                      -- full-text
  + 0.25 * importance                                     -- typed scalar
) * EXP(-0.005 * DATEDIFF(:qdate, event_time))            -- structured
  * (CASE WHEN event_time BETWEEN :t0 AND :t1
          THEN 1 ELSE 0.25 END)                           -- structured
  * (CASE WHEN JSON_CONTAINS(entities, :ent)
          THEN 1.25 ELSE 1 END)                           -- JSON
  * (CASE level WHEN 0 THEN 0.80 WHEN 1 THEN 1.0 WHEN 2 THEN 1.05 END)
DESC LIMIT 5;
```

Four retrieval modalities fused in one `ORDER BY`. One index plan. One
round-trip. No sidecar vector store, no full-text cluster, no JSON
extractor proxy, no application-layer merge. Less surface area =
fewer failure modes.

## Reproducibility

```
bun run migrate     # schema on TiDB
bun run bench       # 40 questions × 5 approaches, writes runs table
bun run summary     # pivot + ASCII bars + Markdown
bun run chart       # SVG + latest.json
```

Any `PER_SLICE` value runs the same code path. Every outcome is
persisted to the `runs` table on the same cluster — ingest tokens,
retrieval tokens, latency, judge verdict. The numbers are queryable
with standard SQL.

Raw outcomes: `results/bench-2026-04-19T00-58-01-355Z.json`.
