# Design brief — memory-bench pitch site

Target prizes at AGI House Agent Harness Build Day: **Track 2 (Agent
Memory Architecture)** and **Best Use of TiDB**. Demos 7pm 2026-04-18.

Previous deploy at `sonzai-agi-tidb.vercel.app` — mine it for palette
and typography. The page shape is new.

---

## The thesis, one sentence

> *TiDB lets us set up five write-time memory strategies, run them in
> parallel on one cluster against identical LongMemEval fixtures, and
> produce a controlled ablation. The approach column is the only
> variable. Off TiDB, running this study is impossible without
> multiplying the infrastructure.*

The page argues that single point. Not "which memory wins." Not
"how Sonzai stores memories." **TiDB is the experimental substrate
and the bench is the artifact.**

---

## What the page is

A report on a bench. Not a product page. Not a pitch deck. Not a
leaderboard. A bench lives on a table; this page describes the
table, the retrieval, the strategies tested, the infra that made
it possible.

No "winning." No "our thesis." No accuracy deltas in prose. No
deep-dives on how each strategy stores rows or what its supersede
policy is. The individual strategies are *named column values* — the
policy behind each is out of scope for this page. If a judge wants
the detail they click through to the code.

---

## What exists in the repo

Source of truth:

- `README.md` — voice reference. Tight, technical, factual. Match it.
- `src/sonzai/retriever_5lens.ts` — the hybrid SQL. Lift verbatim.
- `src/db/schema.sql` — the `memories` table. Mirror the column list.
- `web/bench/latest.json` — per-approach × per-slice results. Use for
  the results block; never for hero prose.

---

## The five strategies (brief, no deep-dive)

Each strategy is a named value for the `approach` column in `memories`.
Each adds one write-time move over the previous. One line per row.

| Approach | What changes at write time |
|---|---|
| `raw_vector` | Every turn embedded and stored. Baseline. |
| `progressive_summary` | Every 5 turns compressed to an LLM summary. |
| `hierarchical` | Recent 20 turns raw + older turns summarised. |
| `typed_facts` | LLM-extracted atomic facts with `importance`, `event_time`, `entities`. |
| `spo_supersede` | SPO triples + novelty tags + deterministic supersede on `(subject, predicate)` collision. |

That's enough. Don't render panels on "how each approach works in
detail." The table above is the complete explanation this page owes
the reader on the approaches themselves.

---

## How the ablation works — this is the load-bearing section

This is what the page needs to make obvious. Not a narrative — a
mechanism. Aim for a diagram or a structured block, not prose.

The bench:

1. Ingest identical LongMemEval fixtures into `memories` for all five
   approaches. Each approach writes rows tagged with its own
   `approach` value.
2. For each question in the fixture, run the same hybrid SQL retriever
   five times — once per approach — changing only `WHERE approach = ?`.
3. Pass the retrieved context to the same answering LLM.
4. Grade with the same judge. Record per-approach, per-slice scores
   in the `runs` table (same cluster, same SQL dialect).
5. Aggregate. Chart. Read results.

Invariants that TiDB makes trivial (and would be murderous elsewhere):

- **One snapshot.** All five approaches retrieve from one cluster at
  the same logical time. No replica lag between approaches.
- **One retriever.** Same SQL, same indexes, same query plan shape.
  The only change across approaches is a `WHERE` predicate.
- **One schema.** All approaches share `memories(...)`. No per-approach
  migrations, no per-approach client library.
- **One results store.** Judge scores, tokens, and latencies land in
  one `runs` table queryable with plain SQL. No metrics pipeline.
- **Parallel execution.** Multiple approaches can ingest concurrently
  under one connection pool. TiDB's HTAP (TiKV + TiFlash) serves live
  retrieval and analytical `bun run summary` passes over the same rows.

Render this as a **single diagram + labelled list**, not a wall of
text. A small SVG works: left-to-right — LongMemEval fixtures → five
parallel ingest lanes (each tagged with an approach) → one shared
`memories` table → the same retriever × 5 → the same judge → one
`runs` table → chart. Plain SVG, no library, no animation.

The diagram carries the page's core pitch more than anything else on
it. Spend time on this.

---

## The retrieval — the engineering anchor

One SQL statement, lifted verbatim from `retriever_5lens.ts`. Every
approach reads through this statement. Only the `approach` predicate
changes.

Render as a syntax-highlighted monospace card. Keep inline comments
readable:

- `-- vector` on the `VEC_COSINE_DISTANCE` line
- `-- full-text` on the `LIKE` line
- `-- importance` on the importance scalar
- `-- recency decay` on the `EXP(DATEDIFF(...))` line
- `-- temporal window` on the `BETWEEN` clause
- `-- JSON entity` on the `JSON_CONTAINS` clause
- `-- level-weighted boost` on the `CASE level`
- `-- supersede filter` on `WHERE superseded_at IS NULL`

One paragraph below: *"This is the retriever. Every approach above
runs through it. Only `WHERE approach = ?` changes."*

Small link: `src/sonzai/retriever_5lens.ts →`

---

## The schema — one line

Single monospace line mirroring `schema.sql` column order:

```
memories(approach, agent_id, level, content, event_time,
         importance, entities, embedding, subject, predicate,
         object, superseded_at, ...)
```

Caption: *"One table. Five approaches. The retriever fuses four
modalities over this row — vector, full-text, JSON, structured —
in a single `ORDER BY`."*

---

## Why TiDB, specifically

Four short bullets. No competitive table.

- **Vector + full-text + JSON + structured** predicates compose as
  first-class operators in one `ORDER BY`. No sidecar stores. No
  two-phase merge. No app-code rerank.
- **One table, five approaches.** The `approach` column is the whole
  multi-tenant isolation. Running an ablation is a `WHERE approach = ?`
  change — not a new schema, not a new client.
- **`superseded_at IS NULL`** is a predicate on an indexed column.
  Contradictions retire at write time and never resurface at read —
  same SQL, no app filter.
- **HTAP.** TiKV serves live retrieval. TiFlash serves analytical
  scans over the same rows when the bench aggregates `$/correct`,
  tokens, and latency. One cluster, two workloads.

Close with one sentence: *"The whole bench — ingest, retrieval, judge
scoring, analytical aggregation — runs through one `memories` table
on one TiDB Serverless cluster."*

---

## What this costs off TiDB — required section

Purpose: make the TiDB argument visceral. On any other substrate, the
ablation either fragments or stops being controlled.

Lede:

> *The retriever fuses vector, full-text, JSON, and structured
> predicates in one `ORDER BY`. One statement, one plan, one
> transaction, one snapshot. On any other substrate, that fusion
> fragments — and the ablation stops being controlled.*

Four-row substrate table. Same format as the approaches table. Each
row: substrate, what breaks, what extra infra you'd need.

| Substrate | What breaks | Infra required |
|---|---|---|
| **Postgres + pgvector** | Vector and full-text don't fuse into one index plan. Run separately, rerank in app code. | Two index scans, app-layer merge. `ORDER BY` lives in TypeScript. |
| **Pinecone + Postgres** | Pinecone holds vectors; Postgres holds content. Dual-write on every ingest. Under load Pinecone lags Postgres by seconds to minutes. | Dual-write orchestrator, idempotency keys, DLQ, async reconciler. |
| **Elastic + Pinecone + Postgres** | Three stores. Three dual-writes. Three reconcilers. Three schema migrations per change. | Three cluster ops, query fanout, app-code merge. |
| **ScyllaDB** | No first-class vector, no first-class FTS. External indexers rebuild both. | Back to async dual-write + separate vector + separate FTS clusters. |

Three fixed costs every alternative forces:

- **Dual-write retries** — write store A, then B, handle B failing
  after A committed. Saga orchestration, idempotency, DLQs.
- **Async indexers** — worker consumes the write log, updates the
  secondary store. Seconds to minutes of lag under backpressure.
  Produces visible drift.
- **Two-phase retrieval** — fetch top-K from one store, pull rows
  from another, merge in app code. `ORDER BY` becomes JavaScript.

Closing paragraph. The load-bearing claim:

> *For an ablation, the sync tax is fatal. A controlled comparison
> requires every strategy to read through an identical retrieval
> path over the same snapshot of data. When retrieval is two-phase
> over async-replicated stores, "the same" is fiction — `raw_vector`
> and `spo_supersede` can see data that differs by whatever the
> replica lag happens to be at that moment. A percentage gap between
> them stops being attributable to the write-time move. It could
> just be infra drift.*
>
> *TiDB's unique property for this study isn't speed. It's that one
> connection, one statement, one snapshot lets the `approach` column
> actually be the only variable. Off TiDB, this bench doesn't exist.*

Optional visual: side-by-side architecture diagram. **TiDB** column:
one `memories` box, five approach-labelled arrows merging back into
it, one `ORDER BY` arrow to `result`. **Without TiDB** column:
Postgres + Pinecone + Elastic boxes, dual-write arrows, async
reconciler worker, two-phase retrieval merger. Plain SVG, no
library, no animation.

---

## Page structure (in order)

1. **Hero** — one claim, no hero number.
   - Headline: *"One TiDB table. Five memory strategies. One SQL query. One ablation."*
   - Subhead: *"The `approach` column is the only variable. TiDB is what makes the study possible."*
   - Chips: `AGI House · Track 2` · `Best Use of TiDB`

2. **The five strategies** — the one-line table (see above). No
   deep-dive panels. No capability chips. Just the table.

3. **How the ablation works** — the diagram + invariants block (see
   "How the ablation works" section above). The load-bearing section.

4. **The retrieval** — one SQL statement, annotated.

5. **The schema** — one line, captioned.

6. **The results** — read from `latest.json`. Render as a matrix
   (5 rows × 4 slices + overall). Use the existing chart.svg if
   present. No winner highlighting. No victory copy. Numbers are
   numbers — let them sit.

7. **Why TiDB, specifically** — the four-bullet block (see above).

8. **What this costs off TiDB** — required section (see above).

9. **Links.**
   - Repo: `github.com/sonz-ai/typed-facts-tidb` (prominent)
   - Files: `src/sonzai/retriever_5lens.ts` · `src/db/schema.sql`
   - Run it: `bun install && bun run migrate && bun run bench`

10. **Footer.** `AGI House · Agent Harness Build Day · 2026-04-18 ·
    Track 2 · Best Use of TiDB` · repo link · sonzai.ai wordmark.

---

## Interaction

This is a report page, not a product page. One page, one scroll. No
interactive picker required. If you want a light tab interaction for
the strategies table (click a row → highlight its cell in the
results matrix), that's fine. Keep it minimal. No scroll animations.
No confetti. No carousels.

---

## Voice rules — do not write

- `wins` / `loses` / `beats` / `outperforms` / `decisively`
- `our thesis` / `we believe` / `we set out to prove` / `we discovered`
- `honest ablation` / `surprising findings` / `non-monotonic` /
  `what we learned`
- Deep explanations of write-time policy (SPO rules, fact extraction
  prompts, importance scoring, supersede thresholds). The policy
  detail is in the code. This page is about the bench.
- Accuracy percentages in hero or subhead prose. Numbers live in the
  results matrix only.
- Emoji. Gradients. Glassmorphism. CTAs. Email signups.
- Any sentence that reads like marketing. Delete it.

Copy reads from `README.md`. Engineering facts only.

---

## Stack

- Static HTML, single `index.html`, no framework.
- Fonts: Inter + JetBrains Mono via Google Fonts.
- Palette: dark `#0a0a0a` background, zinc hierarchy, accent
  `#10b981` or `#34d399` (pick one, be consistent). Accent on SQL
  comment ticks, the "TiDB" side of comparison visuals, the repo
  link, the active state of any tab widget if you use one.
- No libraries beyond Google Fonts.

---

## Visual voice

Dark, typographic, dense. References: arxiv papers with CSS. Stripe
developer docs 2018. `sqlite.org/src`. Left-aligned text on dark
zinc. Monospace for SQL, column names, approach names, numbers.
Sans-serif for prose.

Readable in 90 seconds. Inspectable for 5 minutes without fatigue.

---

## First move

1. Read `README.md` end-to-end. Match its voice.
2. Open `src/sonzai/retriever_5lens.ts`. Copy the SQL verbatim.
3. Open `src/db/schema.sql`. Mirror the column list exactly.
4. Sketch the **"How the ablation works"** diagram before anything
   else. That's the page's load-bearing visual. If the diagram is
   good, the rest of the page writes itself.
5. Sketch the **"What this costs off TiDB"** comparison after.

Then build.

---

## Verify before shipping

A visitor should be able to:

1. State the thesis in one sentence after reading the hero.
2. Name the five strategies after reading the strategies table.
3. Understand how the bench works — five strategies × same retriever
   × one cluster — after reading one diagram.
4. See the single SQL statement that retrieves from all five.
5. See the `memories` row that proves it's one table.
6. Understand, without reading more than a paragraph, why running
   this same ablation off TiDB would require 3× the infra and would
   no longer be controlled.

If yes to all six, ship it. If not, cut whatever's blocking those
reads.
