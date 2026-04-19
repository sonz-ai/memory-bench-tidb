# memory-bench

**AGI House · Agent Harness Build Day · Track 2 + Best Use of TiDB**

> One TiDB cluster. One `memories` table. Five memory architectures
> distinguished by a column. One SQL statement fuses vector, full-text,
> JSON, and structured predicates into a single `ORDER BY`.

Five write-time strategies — from naive cosine retrieval to SPO-deduped
typed rows — share one schema and one retrieval path. Swapping architectures
is a `WHERE approach = ?` change. The whole study runs on one cluster, with
one connection pool, with no sidecar services.

---

## The retrieval

Every approach reads this query:

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
  * (CASE WHEN event_time BETWEEN :t0 AND :t1
          THEN 1 ELSE 0.25 END)                          -- structured
  * (CASE WHEN JSON_CONTAINS(entities, :ent)
          THEN 1.25 ELSE 1 END)                          -- JSON
  * (CASE level WHEN 0 THEN 0.80 WHEN 1 THEN 1.0 WHEN 2 THEN 1.05 END)
DESC LIMIT 5;
```

Four retrieval modalities ranked in one expression. One index plan.
One network round-trip. No two-phase retrieval glue. No application-layer
merge. **Less surface area = fewer failure modes.**

On TiDB it's one statement. The next section explains what the same
study would cost to stand up elsewhere.

---

## The five approaches

Each row adds one write-time move over the previous. Retrieval is the
same SQL statement above for all five — the `approach` column is the
only thing that changes.

### `raw_vector` — baseline
Every user and assistant turn gets embedded and written as a row with
`level = 0`. Retrieval is cosine distance only. This is what "chunk +
embed + cosine" actually looks like when you strip out the framework
wrappers. No importance, no event_time, no entity tags, no supersede.

### `progressive_summary` — read-only summaries
Every five turns, an LLM summarizes the batch into a single
`level = 2` row. Raw turns aren't stored. Retrieval runs only against
summaries. This is the "keep context window small" pattern most chat
apps ship. Compression happens at the granularity of a fixed batch
size, regardless of what the turn contains.

### `hierarchical` — sliding-window of raw + summary
Keep the recent 20 turns as raw `level = 0` rows; summarize older
batches of 10 into `level = 2` rows. Retrieval pulls from both layers
and the hybrid score above decides which level ranks higher per query.
Recent wording is preserved; long tail is compressed.

### `typed_facts` — atomic facts with typed metadata
Every turn triggers a single LLM extraction pass that emits: atomic
facts (`level = 1`), an `importance` score, an `event_time`, and an
entity list. Each atomic fact becomes its own row with its own
embedding. The retrieval query now has real columns to fuse — the
`importance` scalar, the `event_time` recency decay, and the
`JSON_CONTAINS(entities, …)` boost all have something to weight
against. At N=40, this is the approach that indexes `knowledge_update`
best — it hits 90% on that slice because a question like "what is my
current 5K PB?" maps directly to an SPO-shaped retrieval filter.

### `spo_supersede` — SPO triples with deterministic supersede
Two lenses run in parallel per turn: **Cartographer** emits
`(subject, predicate, object)` triples into the schema's typed SPO
columns; **Librarian** tags topic + novelty against a short list of
recent priors. A deterministic merge in code decides what supersedes
what — no LLM composer on the critical path:

1. **SPO collision.** If Cartographer emits `(user, owns_dog, Max)`
   and an alive row already has `(user, owns_dog, *)` with a different
   object, mark that prior row `superseded_at = NOW()` in the same
   transaction. One composite-index lookup on `(approach, agent_id,
   subject, predicate)`.
2. **Librarian fuzzy supersede.** If a Librarian tag's novelty is
   `updates` or `contradicts` and its `may_supersede_content`
   string-overlaps an alive prior, supersede that prior too.

Retrieval filters `WHERE superseded_at IS NULL`, so contradicted facts
never surface — they stay auditable in the table but drop out of the
hot path. At N=40 this approach under-covers the answer-LLM's context
on `knowledge_update` questions where both the old and new values are
useful (e.g. "how has my PB changed?"), and it drops to 30% on that
slice. The architecture isn't the problem; the supersede threshold is
too aggressive for questions that want a history. A softer
decaying-importance policy would recover that slice with a one-function
change.

---

## Why the comparison is cheap on TiDB and expensive elsewhere

The bench requires five things from the storage layer, all at once:

1. **One retrieval query with joint scoring across vector + full-text
   + JSON + structured.** The hybrid `ORDER BY` weights all four
   modalities per row — no pick-top-K-per-index-then-merge.
2. **A predicate that hides superseded rows from retrieval instantly.**
   `WHERE superseded_at IS NULL` on an indexed column, readable in the
   same transaction as the write that marked it.
3. **Write atomicity across multiple rows.** When `spo_supersede`
   inserts a new triple and marks an older one dead, both happen in
   one transaction. Either both land or neither does.
4. **Five writers sharing one schema.** All five approaches write to
   the same `memories` columns. Their outputs are distinguished only
   by the `approach` column, so every row uses the same indexes and is
   read by the same query.
5. **Benchmark analytics on the same cluster.** The `runs` table
   (40 × 5 = 200 rows per PER_SLICE=10 run) lives next to `memories`.
   `bun run summary` pivots it with standard SQL — no export, no ETL,
   no second system.

### On TiDB

One connection pool. One schema migration. One transaction per write.
`ALTER TABLE memories ADD COLUMN …` for every new signal we wanted to
index. Adding a sixth approach is: write a new writer, insert rows
with a new `approach` value, run the bench. Retrieval code doesn't
change. Analytics code doesn't change.

### On Postgres + pgvector

Vector and full-text both exist. Great so far. But:

- **Joint scoring fragments.** pgvector's `<=>` ranks by distance in
  an ORDER BY; `to_tsvector` / `ts_rank` ranks in the same query *only
  if you keep one underlying table*. That works — until you want to
  also weight by `JSON_CONTAINS(entities, …)` and a `CASE` expression
  over `event_time` in the same expression. pgvector's HNSW index
  won't be used if the outer expression isn't the one the index
  understands, so you fall off the index and back to a sequential
  scan. You end up doing: *"take top-K by vector, then top-K by FTS,
  union them, then re-rank in app code with a scoring function that
  reads importance/entities/event_time."* That's two round-trips, and
  the real answer can drop out of the top-5 of each index and never
  reach the re-ranker.
- **Schema sprawl is fine; schema parity under writes is not.** If
  you add a `lens` column and three of the five writers start writing
  it, you now need to guarantee every writer uses the same NULL vs
  default semantics. One table is still tractable — but when teams
  naturally split the vector store off onto a replica or a read-side
  cache, parity starts drifting.
- **Running the ablation still works.** It just costs you the joint
  ranking, which was the whole point of the hybrid `ORDER BY`.

### On Pinecone + Elastic + Postgres (three systems)

This is where the surface area explodes:

- **Every write becomes three writes.** Insert into Postgres (the
  row-of-truth), upsert to Pinecone (vector index), index into Elastic
  (full-text). Three network round-trips per turn, three possible
  failure points.
- **Atomicity is gone.** None of those three support a distributed
  transaction across the others. If the Pinecone upsert fails *after*
  the Postgres insert succeeds, you have a phantom row that retrieval
  won't find. Fix: outbox table + async reconciler. That's a
  ~300-line infrastructure component before you write your first
  writer.
- **Supersede breaks retrieval.** To hide `superseded_at` rows from
  Pinecone, you either delete from Pinecone on supersede (irreversible
  — you lose audit), or filter post-retrieval in app code (the stale
  row consumes a top-K slot that a live row needed). Neither is
  equivalent to a column-predicate.
- **Five approaches = five namespaces.** Each approach gets its own
  Pinecone index, its own Elastic index, its own Postgres table or
  partition. Migrations to add `event_time` or `spo_columns` now fan
  out to N systems × M environments. When a migration half-lands,
  retrieval silently uses mixed schemas.
- **The joint score can't be expressed.** Pinecone's metadata filter
  does equality and ranges; it doesn't do `importance × EXP(-λ ·
  age_days) × CASE …`. You compute the score in the app layer after
  fetching candidates from all three systems, which reopens the
  top-K-drop-out problem.
- **Benchmark analytics need ETL.** `runs` lives in Postgres, token
  stats live in Elastic, vector-retrieval latency lives in Pinecone
  metrics. Joining them for `$/correct` per approach means writing
  another pipeline.

### On Scylla + any vector sidecar

- **No structured expression scoring.** Scylla's CQL doesn't support
  joint expressions in `ORDER BY`. You fetch candidates by partition
  key, pull them into app code, and re-score.
- **JSON is a blob.** No index on JSON paths — `entities` becomes a
  SELECT-and-parse on every candidate, O(N) per query.
- **No `WHERE superseded_at IS NULL`.** You'd use TTL or tombstones.
  Tombstones compact asynchronously, so a freshly-superseded row
  can still ship in retrieval for an unbounded window. The audit
  row survives compaction only if you duplicate it to a separate
  partition.

### The synchronization cost, concretely

Count the moving parts required to answer *"when user says their dog's
name changed from Buddy to Max, does retrieval return Max"* on each
stack:

| Stack | Stores to update | Transactions coordinated | Extra infra |
|---|---|---|---|
| TiDB | 1 (`memories`) | 1 (INSERT + UPDATE) | — |
| Postgres + pgvector | 1 | 1 | — |
| Pinecone + Elastic + Postgres | 3 | 0 (none support 2PC) | outbox + reconciler |
| Scylla + vector sidecar | 2 | 0 | outbox + tombstone-safe retrieval |

The more systems in the loop, the more places the bench can drift
between approaches. If `typed_facts` and `spo_supersede` commit their
vector rows at slightly different times because one reconciler is
slower than the other, their retrieval results are no longer
comparable. You can no longer blame the architecture; you have to
argue with the plumbing first.

On TiDB every approach hits the same WAL, the same HNSW index, the
same row store. The comparison is honest because the plumbing is
identical.

---

## Results (N=40, PER_SLICE=10)

| Approach | single_session | multi_session | temporal | knowledge_update | Overall |
|---|---|---|---|---|---|
| `raw_vector` | 30% | 30% | 70% | 60% | **47.5%** |
| `progressive_summary` | 0% | 10% | 70% | 80% | 40.0% |
| `hierarchical` | 30% | 10% | 40% | 80% | 40.0% |
| `typed_facts` | 10% | 10% | 20% | **90%** | 32.5% |
| `spo_supersede` | 0% | 0% | 0% | 30% | 7.5% |

Full outcomes: `results/bench-*.json`. Chart: `results/chart.svg`.
`runs` table on TiDB stores every per-approach, per-question judgment with
token counts and latency.

---

## Run it

```bash
cp .env.example .env    # TIDB_*, GEMINI_API_KEY
bun install
bun run migrate         # schema on TiDB
bun run bench           # N=PER_SLICE × 4 slices × 5 approaches (default PER_SLICE=10)
bun run summary         # pivot table + ASCII bars + Markdown
bun run chart           # SVG + latest.json
bun run demo            # AGENT_ID=<qid> QUERY="..." — all 5 answers side by side
```

Environment:

```
TIDB_HOST=gateway01.<region>.prod.aws.tidbcloud.com
TIDB_PORT=4000
TIDB_USER=<prefix>.root
TIDB_PASSWORD=<from TiDB Cloud Connect panel>
TIDB_DATABASE=memory_bench
TIDB_SSL_CA=/etc/ssl/cert.pem
GEMINI_API_KEY=AIza...
```

Tunable:

```
PER_SLICE=10            # questions per LongMemEval slice (default 10)
INGEST_CONCURRENCY=5    # questions ingested in parallel
EVAL_CONCURRENCY=6      # questions evaluated in parallel
DB_POOL_SIZE=16         # TiDB connection pool size
```

---

## Layout

```
memory-bench/
├── README.md          · this
├── RESULT.md          · numbers + the retrieval SQL
├── ABOUT.md           · one-paragraph description
├── DECK.md            · slides
├── SCRIPT.md          · 90-second stage script
├── src/
│   ├── db/            · TiDB pool, schema, migration
│   ├── llm.ts         · Gemini chat + embed
│   ├── baselines/     · raw_vector, progressive_summary, hierarchical
│   ├── sonzai/
│   │   ├── writer.ts          · single-shot extractor (typed_facts)
│   │   ├── writer_5lens.ts    · 2-lens + deterministic merge
│   │   ├── retriever.ts       · hybrid scored SQL
│   │   ├── retriever_5lens.ts · same + supersede-aware
│   │   └── lenses/    · cartographer.ts, librarian.ts (+ three unused in 2-lens)
│   └── eval/          · fixtures, answer LLM, judge LLM, runner
├── scripts/           · migrate, bench, summary, chart, demo
├── results/           · bench JSONs, chart.svg, latest.json
└── web/               · static landing page (index.html + chart.svg)
```

---

## License

MIT.
