# Why TiDB — plain English, no jargon

This is the cheat sheet for explaining to any judge (or anyone really)
what we did and why TiDB is the reason we could do it. You don't have
to be a database expert to say any of this. The official TiDB docs are
linked at the bottom — all claims here trace back to them.

---

## What we actually built, in one paragraph

We built five different ways for an AI agent to remember things across
long conversations, and tested all five on the same benchmark. The
trick is that **all five share the same database table, same schema,
and same retrieval query**. Swapping between them is changing one
column value in a `WHERE` clause. That's what lets us compare them
fairly — every approach reads the data the same way.

---

## The thing a memory system needs

When you ask an agent "what did I tell you about my dog?", the system
needs to combine four kinds of search, in one ranked list:

1. **Semantic search** — find messages that *mean* something similar to "dog" (vector similarity).
2. **Keyword search** — find messages that literally contain the word "dog" (full-text / LIKE).
3. **Entity filter** — narrow to messages where the user is mentioned (JSON list of entities).
4. **Structured scoring** — prefer important messages, recent messages, and messages from the right time window.

And for our most sophisticated approach, we need a **fifth** thing: a
way to mark old facts as retired when new facts contradict them, so
retrieval automatically skips outdated information.

---

## Why TiDB makes this easy

TiDB is built to do all four of those things **in one SQL query,
ranked together, in one database, on one row per memory.** No
sidecars, no merging results in application code.

Specifically:

- **Vector search is native.** You declare `VECTOR(1536)` as a column type, build an HNSW index, and `VEC_COSINE_DISTANCE(embedding, :query_vec)` works inside normal SQL. ([Vector Search Overview — TiDB docs](https://docs.pingcap.com/tidb/stable/vector-search-overview/))
- **Full-text search is native.** TiDB ships a full-text index that coexists with vector indexes on the same table. ([Full-Text Search — TiDB docs](https://docs.pingcap.com/tidb/stable/vector-search-full-text-search/))
- **Hybrid search is a documented pattern.** TiDB has a dedicated docs page for combining vector and full-text search in one query, with a ranked `ORDER BY` — this is literally what our retriever does. ([Hybrid Search — TiDB docs](https://docs.pingcap.com/tidb/stable/vector-search-hybrid-search/))
- **Indexed JSON paths work inside the same `WHERE`.** `JSON_CONTAINS(entities, :ent)` is a standard SQL function; no workaround needed. ([JSON Functions — TiDB docs](https://docs.pingcap.com/tidb/stable/json-functions/))
- **Composite indexes on normal columns** (like our `(subject, predicate)` index for SPO triples) fire in the same query plan as the vector and full-text indexes.
- **Analytics run on the same cluster, no ETL.** Our `runs` table — where we store per-question tokens, latency, and accuracy — is queryable with standard SQL on the same cluster the agent writes to, thanks to TiFlash (TiDB's columnar replica layer). ([TiFlash Overview — TiDB docs](https://docs.pingcap.com/tidb/stable/tiflash-overview/))

So the retriever is literally one query that does vector similarity +
keyword match + entity filter + structured scoring + supersede filter
— all ranked together. That's what TiDB calls
[Hybrid Search](https://docs.pingcap.com/tidb/stable/vector-search-hybrid-search/)
in their own docs, and it's the shape our whole benchmark depends on.

---

## Why this would be painful on any other stack

Most database stacks for this kind of problem are **polyglot** —
different database for each job.

- **A vector DB** (Pinecone, Qdrant, Weaviate) handles semantic search.
- **A search engine** (Elastic, OpenSearch) handles keyword search.
- **A SQL DB** (Postgres, CockroachDB) handles structured data, JSON,
  and relationships.

Each of them is great at its specialty. But **no single query can
rank results across all three**. So you have to:

1. Query the vector DB, get top-N candidates.
2. Query the search engine, get top-N candidates.
3. Query the SQL DB, get structured metadata for those candidates.
4. Merge all three lists in your application code.
5. Re-score everything by hand.
6. Return the top 5.

That's **three network round-trips, three failure modes, and a custom
merge function** — for every single retrieval. And it's worse than
that: when we mark a fact as superseded, we'd have to update all three
databases at once (the row in Postgres, the vector in Pinecone, the
document in Elastic). **None of them coordinate with each other.**
There's no way to say "do all three of these updates atomically."
You'd have to build that yourself, or accept that for a few seconds
after any supersede, one of the databases returns stale data.

Even for the parts you might think would be easy:

- **Postgres + pgvector** can do vector search, but it can't fuse
  vector similarity and full-text ranking into the same `ORDER BY` —
  you still run two queries and merge.
- **Graph databases** (Neo4j, Memgraph) look like they'd fit our SPO
  triples, but they're built for multi-hop traversal ("friends of
  friends of friends"). Our lookup is one hop: does a row with this
  subject and predicate exist? That's an indexed column lookup, not a
  graph walk. And graph DBs don't do vector ranking or full-text
  search well — you'd still need a vector store and a search engine
  alongside them, which puts you back in the polyglot-stack nightmare.
- **Vector-only DBs** don't store structured columns or JSON with
  indexes — they're optimized for one workload (semantic similarity)
  and weak at the others.

**TiDB is tailor-made for the thing we need because it's one database
that does all of the jobs together, on one row, in one query.** That's
not a product of us being clever — it's a product of TiDB being built
as a general-purpose SQL database that happens to also ship native
vector search, native full-text search, and native HTAP analytics.

---

## The one-sentence version

> "All five of our memory architectures share the same table, the
> same schema, and the same retrieval query. TiDB is the reason that
> works — it has vector search, full-text search, JSON indexing, and
> structured scoring in one SQL statement, on one row, in one
> database. On any other stack we'd need three separate systems and a
> custom merge function for every retrieval, and we couldn't mark an
> old fact as retired without updating all three databases atomically
> — which none of them support."

---

## Talking points if the judge knows databases

- **Vector column with HNSW index** — `VECTOR(1536)` + `VECTOR INDEX ((VEC_COSINE_DISTANCE(embedding))) USING HNSW`. See [Vector Search Index docs](https://docs.pingcap.com/tidb/stable/vector-search-index/).
- **Hybrid ranking in one ORDER BY** — the pattern TiDB documents as [Hybrid Search](https://docs.pingcap.com/tidb/stable/vector-search-hybrid-search/). We add importance, recency decay, temporal-window boost, and SPO entity match as extra multipliers in the same `ORDER BY`.
- **Soft-delete via indexed DATETIME column** — `superseded_at DATETIME NULL` with `INDEX idx_alive (approach, agent_id, superseded_at)`. One indexed predicate (`WHERE superseded_at IS NULL`) filters out retired rows without a scan.
- **HTAP analytics on the same cluster** — TiKV for hot-path writes, TiFlash for analytical scans of the `runs` table. No ETL pipeline. See [TiFlash Overview](https://docs.pingcap.com/tidb/stable/tiflash-overview/).
- **One-table multi-architecture isolation** — all five approaches tag rows with a `VARCHAR(32) approach` column. `WHERE approach = ?` is the entire architectural switch.

---

## Reference links (TiDB official docs)

| Topic | URL |
|---|---|
| Vector Search Overview | https://docs.pingcap.com/tidb/stable/vector-search-overview/ |
| Vector Search Index (HNSW) | https://docs.pingcap.com/tidb/stable/vector-search-index/ |
| Hybrid Search (vector + full-text) | https://docs.pingcap.com/tidb/stable/vector-search-hybrid-search/ |
| Full-Text Search | https://docs.pingcap.com/tidb/stable/vector-search-full-text-search/ |
| JSON Functions | https://docs.pingcap.com/tidb/stable/json-functions/ |
| TiFlash (HTAP) | https://docs.pingcap.com/tidb/stable/tiflash-overview/ |
| TiDB Cloud Serverless | https://docs.pingcap.com/tidbcloud/select-cluster-tier/ |
