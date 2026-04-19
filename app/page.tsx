import { Explorer } from "@/components/Explorer";

export default function Home() {
  return (
    <>
      <div className="strip">
        <div className="mark">memory-bench</div>
        <div className="meta">
          <span>AGI HOUSE · TRACK 2</span>
          <span className="dot">·</span>
          <span>2026-04-18</span>
          <span className="dot">·</span>
          <a
            href="https://github.com/sonz-ai/memory-bench-tidb"
            target="_blank"
            rel="noopener noreferrer"
          >
            repo →
          </a>
        </div>
      </div>

      <main className="wrap">
        {/* ========= HERO ========= */}
        <section className="hero">
          <div className="chips">
            <span className="chip em">AGI House · Track 2</span>
            <span className="chip">Best Use of TiDB</span>
          </div>

          <h1 className="claim">
            One <span className="mono">TiDB</span> table, five agent-memory
            architectures, one SQL query.
          </h1>

          <p className="subhead">
            An ablation of five agent-memory write paths on one TiDB cluster.
            Same fixtures, same retriever, same LLM — the <code>approach</code>{" "}
            column is the only variable.
          </p>
        </section>

        {/* ========= ARCHITECTURE EXPLORER ========= */}
        <section className="band" id="explorer-section">
          <div className="sec-head">
            <div>
              <p className="eyebrow">§ 01 · architecture explorer</p>
              <h2 className="sec-title">
                Five write paths. Same retrieval surface. Pick one.
              </h2>
            </div>
            <div className="sec-idx">arrow keys ↓ ↑</div>
          </div>

          <Explorer />
        </section>

        {/* ========= HYBRID SQL RETRIEVER ========= */}
        <section className="band">
          <div className="sec-head">
            <div>
              <p className="eyebrow">§ 02 · the hybrid sql retriever</p>
              <h2 className="sec-title">
                This is the retriever. Every architecture runs through it
                unchanged.
              </h2>
            </div>
            <div className="sec-idx">retriever_5lens.ts</div>
          </div>

          <div className="sql-head">
            <span className="src">src/sonzai/retriever_5lens.ts</span>
            <span className="path">
              <a
                href="https://github.com/sonz-ai/memory-bench-tidb/blob/main/src/sonzai/retriever_5lens.ts"
                target="_blank"
                rel="noopener noreferrer"
              >
                open on github →
              </a>
            </span>
          </div>

          <pre
            className="sql"
            dangerouslySetInnerHTML={{
              __html: SQL_HTML,
            }}
          />

          <p className="sql-foot">
            Vector · full-text · importance · recency decay · temporal window ·
            JSON entity · level-weighted boost · supersede filter — all in one{" "}
            <code>ORDER&nbsp;BY</code>. Every architecture on this page
            retrieves through this exact query. Only the <code>:approach</code>{" "}
            predicate changes.
          </p>
        </section>

        {/* ========= SCHEMA ONE-LINER ========= */}
        <section className="band">
          <div className="sec-head">
            <div>
              <p className="eyebrow">§ 03 · schema</p>
              <h2 className="sec-title">
                One table. Five architectures. All five retrievals go through
                it.
              </h2>
            </div>
            <div className="sec-idx">schema.sql</div>
          </div>

          <div className="schema">
            <div className="sig">
              <span className="t">memories</span>
              <span className="p">
                (<span className="hi">approach</span>, agent_id, level, content,
                event_time, importance, entities, embedding, subject, predicate,
                object, superseded_at, …)
              </span>
            </div>
            <div className="cap">
              One table. Five approaches. Five capabilities composed in one{" "}
              <span
                style={{
                  color: "var(--accent)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                ORDER BY
              </span>
              .
            </div>
          </div>
        </section>

        {/* ========= WITHOUT TIDB ========= */}
        <section className="band">
          <div className="sec-head">
            <div>
              <p className="eyebrow">§ 04 · without tidb</p>
              <h2 className="sec-title">What this costs off TiDB.</h2>
            </div>
            <div className="sec-idx">the expensive version</div>
          </div>

          <p className="polyglot-lede">
            The retriever fuses{" "}
            <span className="em">vector, full-text, JSON, and structured</span>{" "}
            predicates in one <code>ORDER BY</code>. One statement, one plan,
            one transaction, one snapshot. On any other substrate, that fusion
            fragments — and the ablation stops being controlled.
          </p>

          <div className="substrates-wrap">
            <table className="substrates">
              <thead>
                <tr>
                  <th>Substrate</th>
                  <th>What breaks</th>
                  <th>Infra you&rsquo;d need</th>
                </tr>
              </thead>
              <tbody>
                <tr className="tidb-row">
                  <td className="name" data-label="Substrate">
                    TiDB
                  </td>
                  <td className="break" data-label="What breaks">
                    Nothing. Vector + full-text + JSON + structured in one row,
                    one index plan, one snapshot.
                  </td>
                  <td className="infra" data-label="Infra">
                    One <code>memories</code> table. One connection pool. One
                    repo.
                  </td>
                </tr>
                <tr>
                  <td className="name" data-label="Substrate">
                    Postgres + pgvector
                  </td>
                  <td className="break" data-label="What breaks">
                    Vector and full-text don&rsquo;t fuse into one index plan.
                    Run them separately, rerank in app code.
                  </td>
                  <td className="infra" data-label="Infra">
                    <code>ORDER BY</code> lives in TypeScript, not SQL. Two
                    index scans, app-layer merge.
                  </td>
                </tr>
                <tr>
                  <td className="name" data-label="Substrate">
                    Pinecone + Postgres
                  </td>
                  <td className="break" data-label="What breaks">
                    Pinecone holds vectors; Postgres holds content. Dual-write
                    every ingest. Under load, Pinecone lags Postgres by seconds
                    to minutes.
                  </td>
                  <td className="infra" data-label="Infra">
                    Dual-write orchestrator + idempotency keys + dead-letter
                    queue + async reconciler.
                  </td>
                </tr>
                <tr>
                  <td className="name" data-label="Substrate">
                    Elastic + Pinecone + Postgres
                  </td>
                  <td className="break" data-label="What breaks">
                    Three stores, three dual-writes, three reconciliation jobs,
                    three schema migrations per change.
                  </td>
                  <td className="infra" data-label="Infra">
                    Three cluster ops, query fanout, app-code merge.
                  </td>
                </tr>
                <tr>
                  <td className="name" data-label="Substrate">
                    ScyllaDB
                  </td>
                  <td className="break" data-label="What breaks">
                    No first-class vector, no first-class FTS. External indexers
                    rebuild both.
                  </td>
                  <td className="infra" data-label="Infra">
                    Back to async dual-write + separate vector + separate FTS
                    clusters.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="fixed-costs">
            <div className="fc">
              <div className="fc-title">
                <span className="dash">—</span> Dual-write retries
              </div>
              <div className="fc-body">
                Write store A, then store B, handle B failing <em>after</em> A
                committed. Saga orchestration, idempotency, DLQs.
              </div>
            </div>
            <div className="fc">
              <div className="fc-title">
                <span className="dash">—</span> Async indexers
              </div>
              <div className="fc-body">
                A worker consumes the write log and updates the secondary store.
                Seconds-to-minutes of lag under backpressure. Visible drift
                between stores.
              </div>
            </div>
            <div className="fc">
              <div className="fc-title">
                <span className="dash">—</span> Two-phase retrieval
              </div>
              <div className="fc-body">
                Fetch top-K from one store, pull rows from another, merge and
                rerank in application code. The <code>ORDER BY</code> becomes a
                JavaScript function.
              </div>
            </div>
          </div>

          <div className="polyglot-close">
            <p>
              <span className="em">
                For an ablation, the sync tax is fatal.
              </span>{" "}
              A controlled comparison requires every architecture to read
              through an identical retrieval path over the same snapshot. When
              retrieval is two-phase over async-replicated stores, &ldquo;the
              same&rdquo; is fiction — <code>raw_vector</code> and{" "}
              <code>spo_supersede</code> can see data that differs by whatever
              the replica lag happens to be at that moment. A gap between them
              stops being attributable to the write-time move. It could just be
              infra drift.
            </p>
            <p>
              TiDB&rsquo;s unique property for this study isn&rsquo;t
              &ldquo;it&rsquo;s fast.&rdquo; It&rsquo;s that one connection, one
              statement, one snapshot lets the <code>approach</code> column
              actually be the only variable.
            </p>
          </div>
        </section>

        {/* ========= LINKS ========= */}
        <section className="band">
          <div className="sec-head">
            <div>
              <p className="eyebrow">§ 05 · run it</p>
              <h2 className="sec-title">
                Three commands. One cluster. Five architectures behind the same
                query.
              </h2>
            </div>
            <div className="sec-idx">open source</div>
          </div>

          <div className="links">
            <div className="link-row">
              <div className="label">repo</div>
              <div className="value">
                <a
                  href="https://github.com/sonz-ai/memory-bench-tidb"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  github.com/sonz-ai/memory-bench-tidb
                </a>
              </div>
            </div>
            <div className="link-row">
              <div className="label">run</div>
              <div className="value">
                <span className="dim">$</span> bun install &amp;&amp; bun run
                migrate &amp;&amp; bun run bench
              </div>
            </div>
          </div>
        </section>

        <footer className="foot">
          <div className="row">
            <span>AGI House</span>
            <span className="dot">·</span>
            <span>Agent Harness Build Day</span>
            <span className="dot">·</span>
            <span>2026-04-18</span>
            <span className="dot">·</span>
            <span>Track 2</span>
            <span className="dot">·</span>
            <span>Best Use of TiDB</span>
            <span className="dot">·</span>
            <a
              href="https://github.com/sonz-ai/memory-bench-tidb"
              target="_blank"
              rel="noopener noreferrer"
            >
              github.com/sonz-ai/memory-bench-tidb
            </a>
            <span className="spacer"></span>
            <span className="mark-end">sonzai.ai</span>
          </div>
        </footer>
      </main>
    </>
  );
}

// Lifted verbatim from src/sonzai/retriever_5lens.ts — shown as-is so the
// page surface matches the repo. Using innerHTML keeps the hand-tuned
// span class colouring.
const SQL_HTML = `<span class="kw">SELECT</span> <span class="col">id</span>, <span class="col">content</span>, <span class="col">event_time</span>, <span class="col">importance</span>
<span class="kw">FROM</span>   <span class="tbl">memories</span>
<span class="kw">WHERE</span>  <span class="col">approach</span>      <span class="op">=</span> <span class="str">:approach</span>                              <span class="com">-- the ONLY thing that varies</span>
  <span class="kw">AND</span>  <span class="col">agent_id</span>      <span class="op">=</span> <span class="op">:aid</span>
  <span class="kw">AND</span>  <span class="col">superseded_at</span> <span class="kw">IS NULL</span>                             <span class="com">-- supersede lives in the WHERE</span>
<span class="kw">ORDER BY</span> (
    (<span class="num">0.55</span> <span class="op">*</span> (<span class="num">1</span> <span class="op">-</span> <span class="fn">VEC_COSINE_DISTANCE</span>(<span class="col">embedding</span>, <span class="op">:q_vec</span>))    <span class="com">-- vector · HNSW</span>
<span class="op">   +</span>  <span class="num">0.20</span> <span class="op">*</span> (<span class="fn">LOWER</span>(<span class="col">content</span>) <span class="kw">LIKE</span> <span class="op">:kw</span>)                      <span class="com">-- full-text</span>
<span class="op">   +</span>  <span class="num">0.25</span> <span class="op">*</span> <span class="col">importance</span>)                                    <span class="com">-- LLM-scored worth</span>
  <span class="op">*</span> <span class="fn">EXP</span>(<span class="op">-</span><span class="num">0.005</span> <span class="op">*</span> <span class="fn">DATEDIFF</span>(<span class="op">:qdate</span>, <span class="col">event_time</span>))              <span class="com">-- recency decay</span>
  <span class="op">*</span> (<span class="kw">CASE WHEN</span> <span class="col">event_time</span> <span class="kw">BETWEEN</span> <span class="op">:t0</span> <span class="kw">AND</span> <span class="op">:t1</span>               <span class="com">-- temporal window</span>
          <span class="kw">THEN</span> <span class="num">1.0</span> <span class="kw">ELSE</span> <span class="num">0.25</span> <span class="kw">END</span>)
  <span class="op">*</span> (<span class="kw">CASE WHEN</span> <span class="fn">LOWER</span>(<span class="col">subject</span>) <span class="op">=</span> <span class="op">:ent</span>                        <span class="com">-- SPO entity match</span>
          <span class="kw">OR</span> <span class="fn">JSON_CONTAINS</span>(<span class="col">entities</span>, <span class="op">:ent_json</span>)                <span class="com">-- JSON index</span>
          <span class="kw">THEN</span> <span class="num">1.3</span> <span class="kw">ELSE</span> <span class="num">1.0</span> <span class="kw">END</span>)
  <span class="op">*</span> (<span class="kw">CASE WHEN</span> <span class="col">lens</span> <span class="op">=</span> <span class="str">'cartographer'</span> <span class="kw">THEN</span> <span class="num">1.1</span> <span class="kw">ELSE</span> <span class="num">1.0</span> <span class="kw">END</span>)   <span class="com">-- typed-row boost</span>
) <span class="kw">DESC</span> <span class="kw">LIMIT</span> <span class="num">5</span>;`;
