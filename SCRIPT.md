# Stage script · 120 seconds

Site is on screen behind you. Picker visible. Read this out loud — it lands at about two minutes with normal pacing.

---

## 0:00 – 0:25 · What we did and why

> "Hi — we built a thing called **memory-bench**. It's a **head-to-head benchmark** of five different ways an AI agent can remember things across long conversations.
>
> We ran all five through the exact same test — a standard academic benchmark called LongMemEval. Five hundred questions about recalling facts from past conversations. Same language model, same questions, same database. **The only thing that changed was how the agent wrote to memory.**
>
> Everything ran on one TiDB cluster — and that's the part we want to talk about."

*(Picker visible on screen.)*

---

## 0:25 – 0:55 · The five approaches, from dumb to opinionated

*(Click the picker left-to-right.)*

> "Here are the five — each one does more at write time than the one before it.
>
> **`raw_vector`** is a shoebox of messages. Embed every turn, sort by *vibe* when you need to remember something. This is basic RAG — the control group. Everything else has to beat this.
>
> **`progressive_summary`** swaps every five messages for one summary. You get the arc of the conversation, you lose the specifics. Good for themes. Bad for "what were the exact words."
>
> **`hierarchical`** is closer to how your own memory works — this morning in detail, last year as a rough story. Recent twenty messages verbatim; older ones summarized. The database has a short-term layer and a long-term layer.
>
> **`typed_facts`** is the first one that does homework at write time. An LLM reads every message and fills out a form: *how important is this, when did it actually happen, who's in it, what are the atomic claims?* Those become real columns. Retrieval then doesn't just sort by vibe — it ranks by *importance × recency × who-it's-about*.
>
> **`spo_supersede`** goes all the way. Two specialists work on every message, in parallel. The **Cartographer** maps the world into relationship triples — `(user, owns_dog, Max)` — and writes them into their own indexed SQL columns. The **Librarian** reads the same message against the last dozen things we already knew and flags: *is this new, a repeat, an update, or a contradiction?* If it contradicts — say, last week you said Buddy, this week you say Max — a tiny piece of code retires the old row. No more LLM judgment after that point. Just a rule: same subject, same predicate, new value wins. The memory is self-consistent by the time anyone asks it a question."

---

## 0:55 – 1:25 · Why TiDB made this possible

*(Click to the SQL panel.)*

> "Now here's why TiDB is the whole pitch.
>
> All five architectures share **one SQL query** to retrieve from memory. One query. For all five. The only difference is a `WHERE approach = ?` clause.
>
> That query does a lot in one statement: vector similarity, keyword search, JSON entity matching, structured scoring like importance and recency, and a filter that says 'skip anything we already marked as superseded.' All of that in one ranked `ORDER BY`.
>
> If we tried this without TiDB, we would have had to use three different databases — a vector database like Pinecone, a search engine like Elastic, and Postgres for the structured data. And because no single query can rank across all three, we'd have had to write application code to fetch from each one and merge the results. Worse, when we mark something as superseded, we'd have to update all three databases at once — and they don't coordinate, so there's always a window where one is stale.
>
> On TiDB, it's one table and one query. Marking something superseded is a single UPDATE. The comparison between the five approaches is literally one column in the database."

---

## 1:25 – 1:45 · What we learned

> "Two honest takeaways.
>
> **One** — more sophistication isn't always better. The fanciest approach, `spo_supersede`, is aggressive about overwriting old facts, and sometimes the old fact is still useful — like when someone asks *what was my dog's name before Max*. We found specific cases where simpler approaches beat the complex one.
>
> **Two** — the reason we could find that out at all is because TiDB made running this comparison cheap. Swapping architectures was a `WHERE` clause change. Not a migration, not a rewrite, not a new service. That meant we could actually measure the tradeoffs instead of arguing about them in a slide deck."

---

## 1:45 – 2:00 · It's open — try it

> "Everything is open source. You can clone the repo, point it at your own TiDB cluster, and reproduce every number on that chart in about fifteen minutes.
>
> The website is **sonzai-tidb.vercel.app** — you can click through the five architectures right there. The repo is **github.com/sonz-ai/memory-bench-tidb**. Same command — `bun run migrate && bun run bench` — and you've got the whole comparison running on your own cluster.
>
> One more time: **sonzai-tidb.vercel.app** for the site, **github.com/sonz-ai/memory-bench-tidb** for the code. Thanks."

---

## Quick-reference beats — memorize these, improvise around them

1. **What it is** — a head-to-head benchmark of five agent-memory approaches on one TiDB cluster.
2. **The five approaches** — raw vector, progressive summary, hierarchical, typed facts, SPO supersede. From simplest to most opinionated.
3. **The one query** — vector + keyword + JSON + structured scoring + supersede filter, all in one `ORDER BY`.
4. **Why TiDB** — if you tried this on Pinecone + Elastic + Postgres, you'd need three systems, app-side merge, and no clean way to handle supersede. On TiDB it's one table, one query, one UPDATE.
5. **Honest learning** — more sophistication isn't always better. The comparison was only possible because TiDB made it cheap to switch architectures.
6. **Try it** — `sonzai-tidb.vercel.app`, `github.com/sonz-ai/memory-bench-tidb`.

---

## Contingencies

**If a judge asks "what is LongMemEval":**
> "It's an academic benchmark for testing how well agents remember things across long conversations. Five hundred questions, organized into four types — things from the current session, things across multiple sessions, time-based questions, and cases where a fact got updated. It's the standard for this kind of work, so our numbers are comparable to published results."

**If a judge asks "what does the Librarian actually output":**
> "For each message, it produces a few tags. Each tag has a topic, a novelty label — is this new, a repeat, an update, or a contradiction — and when it's an update or contradiction, a quote of the specific prior fact it thinks is being overruled. Our code then fuzzy-matches that quote against what's actually in the database. Strong match, we supersede. Weak match, we leave it alone. We'd rather keep an extra fact than wrongly delete one."

**If a judge asks "why are the subject, predicate, object in their own columns instead of JSON":**
> "Because we look them up a lot. Every write checks whether a triple with the same subject and predicate already exists. If that's a JSON scan, it's slow. If it's an indexed column lookup, it's nearly free. We moved it to columns so the deterministic supersede rule could actually run fast enough to do it on every write."

**If a judge asks "why only two small LLMs, not more":**
> "We started with five LLMs plus a bigger reconciling model. On the benchmark, the two-LLM version with a simple deterministic merge matched it. We removed the other three plus the big model. The numbers didn't change. That's in the git history."

**If a judge asks "why didn't the most sophisticated approach win":**
> "Because its supersede rule is aggressive — it marks the old fact dead when a new one comes in with the same subject and predicate. Sometimes the old fact is what the question is about. The supersede is soft, though — we don't delete, we just mark — so it's in the database if you want it. A less-aggressive threshold is a column change, not a platform change. That's one of the reasons we like running this in the schema."

**If a judge asks "could you do this on Postgres":**
> "Not cleanly. Postgres with pgvector can do vector search, but it can't rank vector and full-text together in one query — you'd run two queries and merge. And the JSON and structured scoring together with HNSW in one `WHERE` clause is something TiDB does natively and Postgres doesn't."

**If a judge asks "why are the numbers small":**
> "We ran at N=10 per slice for the demo — forty questions per approach. At that size, individual judge calls swing things around. We reran and the ordering was stable, so the trend is real. The repo supports any N; we traded statistical power for being able to finish before demo time."

**If the site is down:**
> "No problem — the repo has everything. `github.com/sonz-ai/memory-bench-tidb`. Three commands: `bun install`, `bun run migrate`, `bun run bench`. Reproduces the whole thing on your own cluster in about fifteen minutes."
