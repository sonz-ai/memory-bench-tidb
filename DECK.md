# Deck · memory-bench

Five slides. Each slide is one idea.

---

## Slide 1 · What we built

# One TiDB cluster. One `memories` table. Five memory architectures distinguished by a column.

Five write-time strategies share one schema and one retrieval path. Swapping architectures is a `WHERE approach = ?` change. The whole study runs on one cluster with one connection pool.

---

## Slide 2 · The retrieval

Every approach reads this single statement. Vector, full-text, JSON, and structured predicates fused in one `ORDER BY`.

```sql
SELECT id, content, event_time, importance,
       (1 - VEC_COSINE_DISTANCE(embedding, :q_vec)) AS vec_sim
FROM memories
WHERE approach = :strategy
  AND agent_id = :aid
  AND superseded_at IS NULL
ORDER BY (
    0.55 * (1 - VEC_COSINE_DISTANCE(embedding, :q_vec))  -- vector
  + 0.20 * (LOWER(content) LIKE :kw)                     -- full-text
  + 0.25 * importance                                    -- typed scalar
) * EXP(-0.005 * DATEDIFF(:qdate, event_time))           -- structured
  * (CASE WHEN event_time BETWEEN :t0 AND :t1 THEN 1 ELSE 0.25 END)
  * (CASE WHEN JSON_CONTAINS(entities, :ent)
          THEN 1.25 ELSE 1 END)                          -- JSON
  * (CASE level WHEN 0 THEN 0.80 WHEN 1 THEN 1.0 WHEN 2 THEN 1.05 END)
DESC LIMIT 5;
```

One index plan. One round-trip. No sidecar vector store, no full-text cluster, no JSON extractor proxy, no application-layer merge. **Less surface area, fewer failure modes.**

---

## Slide 3 · Why TiDB specifically

| Modality | What it does | TiDB | PG + pgvector | Pinecone/Qdrant | ScyllaDB |
|---|---|---|---|---|---|
| **Vector** (HNSW) | semantic match | ✅ native 8.4 | ✅ ext | ✅ | ❌ |
| **Full-text / LIKE** | lexical fallback | ✅ | ✅ | metadata only | ❌ |
| **Structured scoring expr** | importance × recency × time-window | ✅ | ✅ | ❌ | ❌ |
| **Indexed JSON** | `JSON_CONTAINS(entities, :ent)` | ✅ | ✅ | ❌ | blob only |
| **Composite SPO index** | `(subject, predicate)` collision | ✅ | ✅ | ❌ | ⚠️ MV only |
| **All four fused in ONE `ORDER BY`** | single round-trip | ✅ | ❌ | ❌ | ❌ |

Elsewhere the statement fragments into two-phase retrieval glue: fetch top-N by vector, fetch structured rows by id, re-score in app code. Two round-trips, two failure modes, two places for the comparison to drift.

On TiDB it's one statement. That's why the comparison is honest — every approach runs through an identical retrieval path, not "identical-ish after we normalize three different query shapes."

---

## Slide 4 · The five approaches

Each adds one write-time move over the previous.

| Approach | What's added |
|---|---|
| `raw_vector` | Embed every turn. Cosine retrieval. |
| `progressive_summary` | Summarize every 5 turns. Retrieve summaries. |
| `hierarchical` | Recent 20 raw + older summarized. |
| `typed_facts` | Atomic fact extraction. LLM-scored importance. `event_time`. Entity tagging. |
| `spo_supersede` | Cartographer SPO triples + Librarian novelty tags. Deterministic supersede: `(subject, predicate)` collision marks the prior row dead. No LLM composer on the critical path. |

Everything writes into `memories`. Everything is read with Slide 2's query.

---

## Slide 5 · The numbers (N=40, PER_SLICE=10)

`<INSERT results/chart.svg>`

| Approach | single | multi | temporal | knowledge_update | Overall |
|---|---|---|---|---|---|
| `raw_vector` | 30% | 30% | 70% | 60% | **47.5%** |
| `progressive_summary` | 0% | 10% | 70% | 80% | 40.0% |
| `hierarchical` | 30% | 10% | 40% | 80% | 40.0% |
| `typed_facts` | 10% | 10% | 20% | **90%** | 32.5% |
| `spo_supersede` | 0% | 0% | 0% | 30% | 7.5% |

The trade-offs are in the data — summarization trades single-session for temporal and knowledge_update; typed-fact indexing gets 90% on the slice it's designed for; aggressive supersede under-covers the answer-LLM's context.

**The point isn't which row wins.** Each approach was implemented in < 100 LOC of writer code. Each runs through the same retrieval. The `runs` table on the same cluster holds every per-approach judgment, tokens, and latency — queryable with standard SQL.

Anyone can clone this repo, point it at TiDB Serverless, run `bun run bench`, and produce the same chart in fifteen minutes. That's what this is.
