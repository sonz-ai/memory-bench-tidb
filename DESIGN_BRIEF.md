# Design brief — memory-bench pitch site

Target: AGI House Agent Harness Build Day, demos 7pm, 2026-04-18.
Prizes: **Track 2 (Agent Memory Architecture)** and **Best Use of TiDB**.

Existing deploy at `sonzai-agi-tidb.vercel.app` — mine for palette +
typography. Page shape is new. The old shape leaned on winner framing
and accuracy deltas. This one doesn't.

We will deploy a new one at sonzai-tidb.vercel.app

---

## What the site is

**An architecture explorer.** Not a pitch deck, not a leaderboard.

The project is one TiDB table that runs **five agent-memory architectures**
behind **one hybrid SQL retriever**. The page's job is to make a visitor
pick one of the five, see exactly what its write path does, see what SQL
retrieves it, and see which TiDB capabilities that approach exercises —
then do it for another. The interaction is the point: the comparison is
a column rename, and the page should make that physical.

### The single claim the site carries

> **One TiDB table. Five agent-memory architectures. One SQL retriever.
> Switch the `approach` column — the whole comparison is a column rename.**

That's it. No "winning," no "losing," no "our thesis," no "honest
ablation" language, no accuracy numbers in hero prose, no triumph.

---

## The five approaches (use these names verbatim — the repo was renamed)

Rename note: the repo previously used `sonzai_lite` and `sonzai_lite_5_lens`.
Those names are **dead**. Use the new names everywhere:

| Approach | What it adds over the previous row | TiDB features used |
|---|---|---|
| `raw_vector` | Embed every turn, store it. Cosine retrieval. Zero write-time compute. | Vector (HNSW) |
| `progressive_summary` | Summarize every 5 turns. Retrieve over summaries via cosine. | Vector (HNSW) |
| `hierarchical` | Keep recent 20 raw, summarize older in 10-turn batches. Retrieve over both. | Vector (HNSW) + level column |
| `typed_facts` | One LLM call per turn extracts `importance` (0..1), `event_time`, `entities`, atomic facts. Hybrid retrieval: vector + lexical + importance + recency decay + temporal-window boost. | Vector + FTS + JSON (`entities`) + scalar scoring |
| `spo_supersede` | Two LLM calls per turn. Cartographer extracts SPO triples into indexed columns; Librarian flags novelty. **Deterministic merge in code:** `(subject, predicate)` collision OR Librarian `updates/contradicts` flag → mark prior row `superseded_at`. Retrieval adds `AND superseded_at IS NULL`. | Vector + FTS + JSON + composite index on SPO (`idx_spo`) + indexed `superseded_at` + HTAP (TiFlash for `runs` analytics) |

Each row of the picker adds **one write-time move** over the previous row.
`raw_vector` adds nothing. `progressive_summary` adds compression.
`hierarchical` adds layering. `typed_facts` adds LLM-scored importance
and event-time anchoring. `spo_supersede` adds SPO dedup and supersede.

---

## Page — section by section

### 1. HERO — one claim, no number

Headline: *"One TiDB table, five agent-memory architectures, one SQL query."*
Subhead:  *"Switch the `approach` column. Run the retriever. That's the whole comparison."*
Chips (small, neutral): "AGI House · Track 2" · "Best Use of TiDB"

**No big percentage. No vs. Save the space for the picker.**

### 2. ARCHITECTURE PICKER — the centrepiece

Five selectable entries, equal visual weight:

```
raw_vector · progressive_summary · hierarchical · typed_facts · spo_supersede
```

Picker form is your call — tabs, vertical nav, chip buttons. Must feel
tactile; arrow-key navigable; no 500ms fades. Default selection:
**`spo_supersede`** (it's the most write-heavy and the most instructive
to read; baselines are scaffolding).

Selecting one updates **four adjacent panels**:

#### (a) Write path — ≤2 sentences of prose + a compact diagram

| Approach | Diagram shape |
|---|---|
| `raw_vector` | turn → embed → insert |
| `progressive_summary` | turn → (buffer 5) → summarize → embed → insert |
| `hierarchical` | turn → (recent verbatim / older summarized) → embed → insert |
| `typed_facts` | turn → single LLM extract {importance, event_time, entities, facts} → embed → insert |
| `spo_supersede` | turn → [Cartographer ‖ Librarian] → deterministic merge → insert + UPDATE supersede |

#### (b) Sample rows from `memories` — 3-5 rows in a monospace mini-table

Render as:

```
SELECT * FROM memories WHERE approach = '<this>' LIMIT 5
```

Show the columns that distinguish this approach. Realistic dummy data
is fine. Specifically:

- `raw_vector`: `content`, `embedding` populated. Everything else NULL.
- `progressive_summary`: `content` is a summary; `level=2`; `embedding` populated.
- `hierarchical`: mix of `level=0` (raw) and `level=2` (summary) rows.
- `typed_facts`: `importance`, `event_time`, `entities` (JSON), `embedding` populated. SPO columns NULL.
- `spo_supersede`: SPO columns (`subject`, `predicate`, `object`) populated. `superseded_at` nullable; show one row where it's `NOW()`-ish to illustrate a collapsed contradiction.

#### (c) TiDB features this approach exercises

New panel. Short checklist. For the selected approach, show which TiDB
features are firing. Unused features are dimmed, not hidden.

```
✓ Vector (HNSW cosine)
✓ Full-text / LIKE index
✓ Indexed JSON paths (JSON_CONTAINS)
✓ Composite index on SPO columns (idx_spo)
✓ Indexed supersede column (idx_alive)
✓ HTAP columnar (TiFlash) for runs analytics
```

This is the panel that makes "Best Use of TiDB" physical — judges see
which capabilities each approach leans on, not a marketing table.

#### (d) What this architecture isolates — one sentence, factual

Not "does it win." What write-time move this approach adds over the
previous one. Example for `spo_supersede`:

> *"Adds SPO extraction + deterministic supersede on top of `typed_facts`.
> Isolates whether write-time contradiction resolution earns its cost."*

### 3. THE HYBRID SQL RETRIEVER

Full SQL block, syntax-highlighted, lifted directly from
`src/sonzai/retriever_5lens.ts`. Do NOT paraphrase. In-code comments
name each signal:

```
-- vector · full-text · importance · recency decay ·
-- temporal window · JSON entity · SPO entity · supersede filter ·
-- level-weighted boost
```

One paragraph below:

> *"This is the retriever. Every architecture runs through it. Only the
> `approach` predicate changes. Even the unused signals (e.g. SPO boost
> on `raw_vector`, which has NULL SPO columns) are no-ops, not errors —
> they stay in the query so the retrieval path is literally identical
> across approaches."*

Small path link: `src/sonzai/retriever_5lens.ts →`

### 4. SCHEMA ONE-LINER

Single monospace line, exactly mirroring `src/db/schema.sql` column order:

```
memories(approach, agent_id, level, content, event_time, importance,
         entities, embedding, lens, subject, predicate, object,
         valence, kind, topic, superseded_at, supersedes_id)
```

Caption: *"One table. Five architectures. All five retrievals go through it."*

### 5. WITHOUT TIDB — the expensive version

**New section. This is the one that wins Best Use of TiDB.** Show what
running this same comparison would cost if TiDB weren't the backbone.

Two-column side-by-side, left = with TiDB, right = without. Keep it tight
(prose, not a marketing table).

#### With TiDB

- One `memories` table. Five `approach` values. Vector + FTS + JSON + SPO columns on the same row.
- Retrieval = one `SELECT ... ORDER BY` that fuses vector cosine, lexical LIKE, importance, recency decay, temporal window, JSON entity match, SPO entity match, and supersede filter.
- Supersession is `UPDATE memories SET superseded_at = NOW()` on one indexed column. The retriever reads `AND superseded_at IS NULL` against the same index.
- Five approaches implemented. One schema migration. One connection pool. One repo.

#### Without TiDB (the polyglot stack)

- **Vector**: Pinecone or Qdrant.
- **Full-text**: Elastic or OpenSearch.
- **Structured scoring + JSON + SPO columns**: Postgres (or CockroachDB).

The same retrieval now requires:

1. **Three backends**. Vector similarity lives in Pinecone. Lexical match lives in Elastic. Importance, recency, temporal window, JSON entities, SPO columns live in Postgres.
2. **No single `ORDER BY` can fuse them.** You fetch top-N by vector, top-N by lexical, JOIN-or-fetch structured rows by id, re-score in application code. Two network round-trips in the best case, three if the top-Ks don't overlap enough.
3. **Supersession becomes a distributed write**. A single `superseded_at` change is an `UPDATE` on Postgres **plus** a delete on Pinecone **plus** a delete on Elastic **plus** cache invalidation. None of these systems support distributed transactions natively. You either accept an eventual-consistency window — stale vectors return for seconds after a contradiction — or you build 2PC between three vendors.
4. **Five approaches × three backends = fifteen integration points.** Each write path must be wired against all three stores (even the no-op ones — `raw_vector` doesn't need Postgres rows, but `spo_supersede` does, and the retriever code must know which). Keeping the *retrieval path identical across approaches* is no longer free — it's custom merge code per approach.
5. **Analytics require a separate pipeline.** The `runs` table (tokens, $/correct, distractor curves) needs ETL off the hot path into a warehouse. On TiDB, TiFlash serves analytical scans over the same rows the hot path writes to — zero ETL.

**The takeaway sentence:**

> *"One afternoon of plumbing becomes a week. And at the end of the week,
> the five approaches are still not going through an identical retrieval
> path — because no such thing exists when retrieval is application-side
> merge code. TiDB is what makes this comparison measurable at all."*

### 6. WHY TIDB — four engineering anchors

Four short bullets, no competitive table. Positioned after the
polyglot-pain section so the reader already knows what the alternative
costs.

- **HNSW vectors next to FTS indices on the same row.** `ORDER BY` can fuse them.
- **Indexed JSON paths and composite indexes on SPO columns coexist.** `JSON_CONTAINS(entities, ?)` and `idx_spo (approach, agent_id, subject, predicate)` both fire in the same query plan.
- **`superseded_at IS NULL` is a predicate on an indexed column.** Supersession lives in the schema, not in app code. No distributed writes, no eventual-consistency windows.
- **TiKV serves live retrieval. TiFlash serves analytical scans** over the same rows. No ETL from hot path to warehouse.

Closing sentence: *"Vector + full-text + JSON + structured compose in a
single `ORDER BY`. That's the query shape the write-heavy approach
needs — and TiDB is what ships it."*

### 7. LINKS block

Repo (prominent): `github.com/sonz-ai/sonzai-lite-tidb`
Files:
- `src/sonzai/retriever_5lens.ts` — the hybrid retriever
- `src/db/schema.sql` — the one table
- `src/sonzai/lenses/cartographer.ts` — SPO extractor
- `src/sonzai/lenses/librarian.ts` — novelty extractor
- `src/sonzai/writer_5lens.ts` — the deterministic merge (inline, not a separate file)

Run it: `bun install && bun run migrate && bun run bench`

### 8. FOOTER

AGI House · Agent Harness Build Day · 2026-04-18 · Track 2 · Best Use of TiDB · repo link · sonzai.ai wordmark.

---

## Interaction rules

The picker is the only moment of interaction.

- Arrow keys move through the five architectures.
- Panel swaps on click/keypress — instant, no fade. Desktop-app tab, not carousel.
- Default: `spo_supersede`. Baselines are scaffolding.
- No URL hash sync needed.
- No scroll animations, no confetti, no chart zoom. Reference page, not landing page.

---

## Voice rules — do not write

- "wins / loses / beats / outperforms / decisively"
- "our thesis / we believe / we set out to prove"
- "honest ablation / surprising findings / non-monotonic results"
- Accuracy percentages in hero or subhead prose
- Emoji, gradients, glassmorphism, CTAs, email signups
- Any sentence that reads like marketing. Delete it.

Copy reads from the README. Match its voice — engineering facts only.

---

## Stack

- Static HTML, no framework. Existing deploy is one `index.html` with inline `<style>` and inline `<script>`. Keep that pattern.
- Fonts: Inter + JetBrains Mono (Google Fonts).
- Palette: dark `#0a0a0a` background, zinc hierarchy, green accent `#10b981` for engineering anchors (SQL comment ticks, picker active state, repo link). Optional purple `#8b5cf6` for `spo_supersede` to match the chart.

---

## Visual voice

Dark, typographic, dense. References: arxiv papers that happen to have
CSS. Stripe developer docs, 2018. sqlite.org/src. Left-aligned on dark
zinc. Monospace for SQL, column names, approach names, schema, numbers.
Sans-serif for prose only.

Readable in under 90 seconds. Inspectable for 5 minutes without fatigue.

---

## First moves

1. Read `README.md` end-to-end. Mirror its voice.
2. Open `src/sonzai/retriever_5lens.ts`. Copy the SQL verbatim into section 3.
3. Open `src/db/schema.sql`. Mirror the column list in section 4.
4. Sketch the picker interaction before coding. What selects? What updates? What's keyboard-accessible?

Then ship.

---

## Completion check

Does the page let a visitor:

1. Understand what each of the five architectures does at write time, inside **15 seconds** of clicking it?
2. See the single SQL statement that retrieves from all five, unchanged?
3. See the schema row that proves it's one table?
4. Understand **which TiDB capabilities each approach exercises** — and what the comparison would cost on a polyglot stack?

If yes to all four, you're done. If not, cut or rewrite whatever's blocking those four reads.
