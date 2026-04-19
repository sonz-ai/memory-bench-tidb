# Stage script · 120 seconds

Site is on screen behind you. Picker visible. Repo link in the footer. Timer starts when you begin.

---

## 0:00 – 0:20 · What memory-bench is and what we ran

> "memory-bench is an ablation of five agent-memory architectures on one TiDB Cloud Serverless cluster.
>
> We evaluated against **LongMemEval** — the standard academic benchmark for long-horizon agent memory. Five hundred questions, each wrapped in a long multi-session conversation that the agent has to remember across. Four oracle slices: single-session, multi-session, temporal, and knowledge-update. We ran the balanced subset at N=10 and N=50 per slice, same Gemini 3.1 Flash-Lite on every write-side extractor and on the answerer, Gemini 3.1 Pro as the judge.
>
> One table. One schema. One SQL retriever. Swapping architectures is a `WHERE approach = ?` change. That's the whole comparison."

*(Picker visible, at rest on `spo_supersede`.)*

---

## 0:20 – 1:00 · The five architectures

*(Click the picker left-to-right, pausing one beat on each architecture.)*

> "Five write-time strategies. Each row adds exactly one move over the previous one.
>
> **`raw_vector`** — embed every turn, store it, retrieve by cosine. Zero write-time compute. This is where everyone starts.
>
> **`progressive_summary`** — buffer five turns, summarize them, embed the summary, retrieve over summaries. Trades specificity for compression.
>
> **`hierarchical`** — keep the most recent twenty turns verbatim, summarize older ones in ten-turn batches, retrieve over both. A middle ground.
>
> **`typed_facts`** — one LLM call per turn extracts four typed signals: importance zero-to-one, event-time — when the thing happened, not when we stored it — canonical entities, and atomic facts with pronouns resolved. Retrieval becomes hybrid: vector similarity plus lexical match plus importance plus recency decay plus temporal window, all fused in one `ORDER BY`.
>
> **`spo_supersede`** — the most write-heavy row. Two focused LLM extractors run in parallel on every turn. The **Cartographer** pulls subject-predicate-object triples out of the turn — literally `(user, owns_dog, Max)` — and writes them into indexed SQL columns called `subject`, `predicate`, `object`. Not a JSON blob. Actual columns with a composite index. The **Librarian** looks at the same turn against the twelve most recent facts already in memory and tags it as *new*, *reinforces*, *updates*, or *contradicts*. If it's an update or contradiction, it names which specific prior fact gets overruled.
>
> Then a deterministic merge runs in our writer code — not an LLM, just fifteen lines of TypeScript. Two rules. One: if the Cartographer emits a triple with the same subject and predicate as a live row — `(user, owns_dog, Max)` when `(user, owns_dog, Buddy)` already exists — we set that prior row's `superseded_at` to now. Two: if the Librarian flags *updates* or *contradicts* and its candidate supersede-content fuzzy-matches a live prior, same path. Insert and supersede happen in the same transaction. No LLM judgment on the critical path."

---

## 1:00 – 1:25 · The retriever

*(Click to the SQL panel.)*

> "This is the retriever. One `SELECT ... ORDER BY` for all five architectures. Vector cosine, full-text LIKE, indexed JSON entity match, structured scoring — importance, recency decay, temporal-window boost, SPO column match — and `WHERE superseded_at IS NULL` as a predicate on an indexed column.
>
> That last one is the trick that makes write-time contradiction logic actually pay off. When the Cartographer supersedes `(user, owns_dog, Buddy)` at write, the old row stays in the table — it's not deleted — but `superseded_at` becomes non-null, and the retriever's indexed predicate filters it out. Contradictions collapsed at write time never resurface at read time.
>
> Five architectures, identical retrieval path. The `approach = ?` predicate is the only thing that changes across runs."

---

## 1:25 – 1:50 · What TiDB makes trivial — and what it doesn't

> "The reason this works as one query is specifically TiDB. Three things no other single engine ships in-band.
>
> **One** — HNSW vectors next to full-text indices on the same row, both scorable in the same `ORDER BY`. Postgres plus pgvector can't fuse FTS and vector into one ranked query.
>
> **Two** — indexed JSON paths and composite indexes on SPO columns firing in the same plan. Pinecone doesn't do structured columns. Postgres can't do HNSW natively. Scylla doesn't do ranked queries.
>
> **Three** — supersession as a predicate on an indexed column. On a polyglot stack, marking a fact superseded means an `UPDATE` on Postgres, a delete on Pinecone, a delete on Elastic — three distributed writes with no native two-phase-commit, with an eventual-consistency window where the stale vector still returns.
>
> Without TiDB, this same ablation is three backends, fifteen integration points, and application-side merge code per approach. On TiDB it's a column rename."

---

## 1:50 – 2:00 · Why bother

> "The honest finding isn't that one architecture wins. It's that running a five-way write-time ablation with an identical read path is *tractable* — because the backbone makes it tractable. Repo is linked. Schema is one table. `bun run migrate && bun run bench` reproduces every number on any cluster you point it at. Thanks."

---

## Quick-reference beats — memorize these, everything else is connective tissue

1. **Frame** — LongMemEval. 500 questions, four slices, N=10 and N=50. Flash-Lite writer + answerer, Pro judge.
2. **One table, five architectures, one SQL, column rename.**
3. **`spo_supersede` mechanics** — Cartographer extracts SPO triples into indexed columns; Librarian flags novelty vs. priors; deterministic merge in 15 lines of code marks `superseded_at` on collision.
4. **Retriever** — one `SELECT`, eight signals fused, `superseded_at IS NULL` is an indexed predicate.
5. **TiDB specifics** — HNSW+FTS in one `ORDER BY`, JSON+SPO composite in one plan, supersession as an indexed predicate.
6. **Polyglot cost** — three backends, no native 2PC, app-side merge per approach.
7. **Close** — the ablation is measurable *because* TiDB is the backbone.

---

## Contingencies

**If a judge asks "what is LongMemEval":**
> "Academic benchmark from late 2024. Five hundred questions, each embedded in a multi-session conversation history — the agent has to answer from memory, not from the visible context. Four question types: single-session, multi-session, temporal, and knowledge-update. Standard benchmark in the agent-memory literature — we're testing against the same thing papers like MemGPT and LoCoMo grade against, so the comparison is apples-to-apples with published numbers. We run the balanced oracle subset at different N values to trade statistical power against demo-day latency."

**If a judge asks "what does the Librarian actually output":**
> "A list of tags. Each tag has four fields: the content being tagged, a topic string like *pets* or *career*, a novelty enum — *new*, *reinforces*, *updates*, or *contradicts* — and, when it's updates or contradicts, a quoted prior sentence it thinks is being overruled. The merge code fuzzy-matches that quote against live rows. Strong match, we supersede; weak match, we don't. We'd rather preserve a prior than kill it wrongly."

**If a judge asks "why is the Cartographer's output not just another JSON blob":**
> "Because `JSON_CONTAINS` has to scan the JSON column, and a composite index on `(subject, predicate)` is an O(log n) seek. `(user, owns_dog, *)` collision check is the hot path in the merge — running on every write. Making it a column with an index is what makes the supersede rule cheap enough to be deterministic."

**If a judge asks "why only two lenses":**
> "We started with five plus a Gemini Pro composer reconciling them — Archivist, Empath, Timekeeper, Cartographer, Librarian. On the bench the two-lens plus deterministic-merge version matched it. We removed four lenses and a Pro call per turn. Numbers didn't move. That's in the commit history."

**If a judge asks "doesn't two LLM calls per turn defeat the cheapness argument":**
> "Both run in parallel — latency is `max`, not `sum`. Both on Flash-Lite. LongMemEval's median retrieval count per fact is about seven, so two write-time calls pay for themselves at around three reads per fact. `$/correct` is the number that reflects this, and it's in the runs table."

**If a judge asks "why did your most-sophisticated approach not win every slice":**
> "The merge is aggressive. SPO collision marks the old row superseded, so retrieval only sees the new value. But some LongMemEval questions grade on the user seeing both values — 'your PB moved from 22:10 to 22:30.' Supersede is soft — `superseded_at`, not delete — so the row is still there for audit. A less-aggressive threshold is a column change, not a platform change. That's the point of doing this in the schema."

**If a judge asks "could you do this on Postgres":**
> "You could bolt pgvector on, but full-text and vector don't fuse into one `ORDER BY` — you'd query two indexes and merge in application code. And `JSON_CONTAINS` next to HNSW in the same `WHERE` clause? That's TiDB specifically. The query stays one statement because the database doesn't force us to split it."

**If a judge asks "why are the numbers small":**
> "We ran at N=10 per slice for the demo, N=50 for the reference bar on the site — eight judge-flips swings a slice by a lot at N=10, less at N=50, less again at N=500. We reran the ordering and it was stable, so the trend is real. The repo reproduces at any N; `PER_SLICE=500` is the full oracle. We traded statistical power for demo-day wall clock."

**If the site is down:**
> "Repo at `github.com/sonz-ai/memory-bench-tidb`. `bun install && bun run migrate && bun run bench` reproduces the whole thing. One table, five approaches, zero framework magic. The pitch isn't that we win every slice — it's that the comparison is cheap enough to actually run."
