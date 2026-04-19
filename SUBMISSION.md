# memory-bench — submission copy

AGI House · Agent Harness Build Day · 2026-04-18
Target prizes: **Track 2 — Agent Memory Architecture** · **Best Use of TiDB**

---

## Name

memory-bench

## Tagline

One TiDB table. Five memory architectures. One SQL retriever. Switch a column, run the comparison.

## Description

memory-bench is a head-to-head benchmark of five agent-memory architectures on a single TiDB Cloud Serverless cluster. Five write-time strategies — from naive cosine retrieval up to SPO-deduped typed rows with supersession — share one `memories` table, one schema, and one hybrid retrieval query that fuses vector similarity, full-text match, indexed JSON predicates, and structured scoring in a single `ORDER BY`.

Swapping architectures is `WHERE approach = ?` — not a migration, not a separate index, not a sidecar store. Each of the five approaches writes into the same table with a different `approach` tag; the retriever is unchanged across all of them. That's what makes the comparison honest: every architecture goes through an identical read path, not "identical-ish after we normalize three query shapes."

We ran it against LongMemEval's oracle slices (single-session, multi-session, temporal, knowledge-update) with Gemini 3.1 Flash-Lite on every write-side extractor and answer model, and Gemini 3.1 Pro as the judge. Per-turn tokens, per-question latency, and retrieval hits land in a `runs` table on the same cluster — queryable with standard SQL. The full comparison is reproducible end-to-end with `bun run migrate && bun run bench`.

The architectural point isn't that any one approach wins. It's that running a five-way head-to-head with an identical retrieval path is only expressible as one query on TiDB — the same experiment on a polyglot stack (vectors in Pinecone, full-text in Elastic, structured + JSON in Postgres) needs three backends, distributed writes across them for supersession, and application-side merge code per approach. On TiDB it's one `SELECT`.

## Tech Stack

TiDB Cloud Serverless (vector + full-text + JSON + structured in one query), Google Gemini 3.1 Flash-Lite (extractors + answerer), Google Gemini 3.1 Pro (judge), TypeScript, Bun, Elysia, mysql2, LongMemEval

## Repository URL

https://github.com/sonz-ai/sonzai-lite-tidb

## Demo URL

https://sonzai-tidb.vercel.app

## Tracks

- [x] Track 2 — Agent Memory Architecture
- [x] Best Use of TiDB
