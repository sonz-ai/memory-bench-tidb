"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  APPROACHES,
  TIDB_FEATURES,
  type Approach,
  type FlowNode,
  type SampleRow,
} from "@/lib/approaches";

const DEFAULT_INDEX = APPROACHES.findIndex((a) => a.id === "spo_supersede");

interface Col {
  k:
    | "content"
    | "level"
    | "importance"
    | "entities"
    | "spo"
    | "lens"
    | "superseded_at"
    | "embedding";
  label: string;
}

function columnsFor(approachId: string): Col[] {
  const isSPO = approachId === "spo_supersede";
  const isTyped = approachId === "typed_facts";
  const isHier =
    approachId === "hierarchical" || approachId === "progressive_summary";

  const cols: Col[] = [{ k: "content", label: "content" }];
  if (isHier) cols.push({ k: "level", label: "level" });
  if (isTyped) {
    cols.push({ k: "importance", label: "importance" });
    cols.push({ k: "entities", label: "entities (json)" });
  }
  if (isSPO) {
    cols.push({ k: "spo", label: "(subject, predicate, object)" });
    cols.push({ k: "lens", label: "lens" });
    cols.push({ k: "superseded_at", label: "superseded_at" });
  }
  cols.push({ k: "embedding", label: "embedding" });
  return cols;
}

function renderCell(col: Col, row: SampleRow): React.ReactNode {
  if (col.k === "content") {
    return <span style={{ color: "var(--text-1)" }}>{row.content}</span>;
  }
  if (col.k === "embedding") {
    return row.filled.includes("embedding") ? (
      <span style={{ color: "var(--text-3)" }}>[1536d]</span>
    ) : (
      <span className="null">NULL</span>
    );
  }
  if (col.k === "superseded_at") {
    return row.superseded ? (
      <span className="em">2026-04-10</span>
    ) : (
      <span className="null">NULL</span>
    );
  }
  if (col.k === "spo") {
    if (row.subject || row.predicate || row.object) {
      return (
        <span style={{ color: "var(--text-1)" }}>
          ({row.subject ?? "NULL"}, {row.predicate ?? "NULL"},{" "}
          {row.object ?? "NULL"})
        </span>
      );
    }
    return <span className="null">(NULL, NULL, NULL)</span>;
  }
  const v = (row as unknown as Record<string, string | undefined>)[col.k];
  if (v) return v;
  return <span className="null">NULL</span>;
}

function FlowNodes({ nodes }: { nodes: FlowNode[] }) {
  return (
    <div className="flow">
      {nodes.map((n, i) => {
        const arrow =
          i < nodes.length - 1 ? <span className="arrow">→</span> : null;
        if (n.label === "par" && n.par) {
          return (
            <span key={i} className="group">
              <span className="par">
                <span className="par-label">parallel</span>
                {n.par.map((p, pi) => (
                  <span key={pi} className="node">
                    {p.label}
                  </span>
                ))}
              </span>
              {arrow}
            </span>
          );
        }
        const cls = n.em ? "node em" : "node";
        return (
          <span key={i} className="group">
            <span className={cls}>{n.label}</span>
            {arrow}
          </span>
        );
      })}
    </div>
  );
}

export function Explorer() {
  const [current, setCurrent] = useState<number>(DEFAULT_INDEX);
  const buttonsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  const select = useCallback((next: number, focus: boolean) => {
    const i =
      ((next % APPROACHES.length) + APPROACHES.length) % APPROACHES.length;
    setCurrent(i);
    if (focus) {
      // Focus after render
      requestAnimationFrame(() => {
        buttonsRef.current[i]?.focus();
      });
    }
  }, []);

  useEffect(() => {
    const el = pickerRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        select(current + 1, true);
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        select(current - 1, true);
      } else if (e.key === "Home") {
        e.preventDefault();
        select(0, true);
      } else if (e.key === "End") {
        e.preventDefault();
        select(APPROACHES.length - 1, true);
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [current, select]);

  const ap: Approach = APPROACHES[current]!;
  const cols = useMemo(() => columnsFor(ap.id), [ap.id]);
  const activeTidb = useMemo(() => new Set(ap.tidb), [ap.tidb]);

  return (
    <div className="explorer" role="region" aria-label="Architecture explorer">
      <div
        ref={pickerRef}
        className="picker"
        role="tablist"
        aria-orientation="vertical"
        aria-label="memory architecture"
      >
        <div className="picker-label">approach</div>
        {APPROACHES.map((a, i) => {
          const on = i === current;
          return (
            <button
              key={a.id}
              type="button"
              role="tab"
              ref={(el) => {
                buttonsRef.current[i] = el;
              }}
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              data-id={a.id}
              onClick={() => select(i, true)}
            >
              {a.id}
              <span className="tag">{a.tag}</span>
            </button>
          );
        })}
      </div>

      <div className="panels">
        <div className="pane">
          <h3>Write path</h3>
          <div className="body">
            <p>{ap.flow.prose}</p>
            <FlowNodes nodes={ap.flow.nodes} />
          </div>
        </div>

        <div className="pane">
          <h3>
            Sample rows ·{" "}
            <span
              style={{
                color: "var(--text-4)",
                fontFamily: "var(--font-mono)",
              }}
            >
              <span style={{ color: "var(--text-2)" }}>
                SELECT * FROM memories WHERE
              </span>{" "}
              <span style={{ color: "var(--accent)" }}>
                approach = &apos;{ap.id}&apos;
              </span>{" "}
              <span style={{ color: "var(--text-2)" }}>LIMIT 5;</span>
            </span>
          </h3>
          <div className="body">
            <div className="rowtable-wrap">
              <table className="rowtable">
                <thead>
                  <tr>
                    {cols.map((c) => (
                      <th key={c.k}>{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ap.rows.map((row, ri) => (
                    <tr key={ri}>
                      {cols.map((c) => (
                        <td
                          key={c.k}
                          className={c.k === "content" ? "content" : ""}
                        >
                          {renderCell(c, row)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="pane">
          <h3>What this isolates</h3>
          <div className="body isolates">
            <span className="delta">{ap.isolates.delta}</span>
            <div>{ap.isolates.text}</div>
          </div>
        </div>

        <div className="pane">
          <h3>TiDB capabilities</h3>
          <div className="body">
            <div className="feats">
              {TIDB_FEATURES.map((f) => {
                const active = activeTidb.has(f.k);
                return (
                  <div key={f.k} className={active ? "feat on" : "feat"}>
                    <span className="mark">{active ? "✓" : "—"}</span>
                    <span className="lbl">{f.label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
