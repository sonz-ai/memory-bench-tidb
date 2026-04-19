# Stage script · 90 seconds

Site is on screen. Repo link in the footer. Timer starts when you begin.

---

## 0:00 – 0:20 · What we built

> "Five agent-memory architectures on a single TiDB cluster. One table,
> one schema, one retrieval SQL statement. The approaches differ only in
> what they write — retrieval is the same for all of them.
>
> Swapping architectures is a `WHERE approach = ?` change. The whole
> study is one cluster, one connection pool, zero sidecar services."

---

## 0:20 – 0:50 · The retrieval

Click to the SQL panel.

> "Every read from every architecture is this statement. Vector similarity,
> full-text LIKE, typed importance scalar, recency decay, temporal window,
> JSON entity boost, hierarchy boost — all fused in one `ORDER BY`.
>
> Four retrieval modalities. One index plan. One round-trip. `superseded_at
> IS NULL` keeps collapsed facts out of results as a column predicate,
> not as app-side filtering.
>
> On Postgres with pgvector, full-text and vector can't fuse into one
> `ORDER BY`. You'd run two indexes and merge in application code — two
> round-trips, and you'd lose the per-row joint ranking. On Pinecone
> plus Elastic plus a relational store, you'd have three systems and
> three schemas to keep in sync per approach. TiDB is what lets this be
> a single query."

---

## 0:50 – 1:15 · The bench

Click to the chart.

> "PER_SLICE=10. Forty questions from LongMemEval's oracle, four slices.
> Five approaches per question. Gemini 3.1 Flash-Lite on both the agent
> and the judge. The `runs` table on the same cluster stores every
> per-approach outcome with token counts and latency.
>
> The numbers are per-approach per-slice accuracy. Some approaches index
> knowledge_update well — `typed_facts` gets 90% there by writing SPO
> triples the query hits directly. Summarization trades phrasing
> fidelity for ordering fidelity — `progressive_summary` is strong on
> `temporal` and weak on single-session. Raw vector is the floor."

---

## 1:15 – 1:30 · Why TiDB

> "The contribution is architectural. One `memories` table, one
> retrieval query, one connection pool. Less surface area means fewer
> places for this comparison to fail — fewer caches to invalidate,
> fewer schemas to migrate, fewer systems that can drift. Anyone can
> clone this repo, point it at a Serverless cluster, and re-run the
> whole study with `bun run bench`. Thanks."

---

## Contingencies

**"Could this run on Postgres?"**
> "With pgvector and FTS, you get vector and full-text — but they don't
> compose into one `ORDER BY`. You'd query two indexes and merge in the
> app layer, which loses the per-row joint ranking and adds a round-trip.
> `JSON_CONTAINS` next to HNSW next to structured scoring in the same
> expression — that's the TiDB-specific piece."

**"What if we wanted more approaches?"**
> "Add a row to the writer registry, insert with a new `approach`
> value, and re-run. The retrieval SQL doesn't change. That's the point."

**"Why is one of your approaches at 7%?"**
> "`spo_supersede` uses aggressive SPO supersede — writes mark
> contradicting priors as `superseded_at`, and retrieval filters them
> out. Too aggressive for knowledge_update questions where the LLM
> needs to see the progression of a value. Softening the supersede
> policy is a one-function change — the architecture isn't the problem,
> the threshold is."

**"How do I reproduce?"**
> "`bun install`, `bun run migrate`, `bun run bench`. Fifteen minutes
> on a free Serverless tier. Every number in the chart lives in the
> `runs` table on the same cluster — queryable with standard SQL."
