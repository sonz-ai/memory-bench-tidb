import fs from "node:fs";
import path from "node:path";

export interface LMETurn {
  role: "user" | "assistant";
  content: string;
  has_answer?: boolean;
}

export interface LMEQuestion {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string; // "2023/04/10 (Mon) 23:07"
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: LMETurn[][];
}

const DEFAULT_FIXTURE_PATH =
  process.env.LME_ORACLE_PATH ??
  path.join(
    import.meta.dir,
    // hackathon/src/eval → hackathon → sonzai-ai-monolith-ts
    "..",
    "..",
    "..",
    "services",
    "platform",
    "api",
    "evals",
    "longmemeval",
    "data",
    "longmemeval_oracle.json",
  );

export function loadLongMemEvalOracle(
  fixturePath = DEFAULT_FIXTURE_PATH,
): LMEQuestion[] {
  const raw = fs.readFileSync(fixturePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("Expected array of questions");
  return parsed as LMEQuestion[];
}

/**
 * Target slices for the hackathon bench. LongMemEval's question_type field
 * names vary; we map each to our 4 slice families.
 */
export const SLICE_MAP: Record<string, string> = {
  "single-session-user": "single_session",
  "single-session-assistant": "single_session",
  "single-session-preference": "single_session",
  "multi-session": "multi_session",
  "temporal-reasoning": "temporal",
  "knowledge-update": "knowledge_update",
};

export const TARGET_SLICES = [
  "single_session",
  "multi_session",
  "temporal",
  "knowledge_update",
] as const;
export type Slice = (typeof TARGET_SLICES)[number];

export function sliceOf(q: LMEQuestion): Slice | null {
  const s = SLICE_MAP[q.question_type];
  return (s as Slice) ?? null;
}

/** Balanced subset: take up to N from each slice. */
export function balancedSubset(
  all: LMEQuestion[],
  perSlice: number,
): LMEQuestion[] {
  const bySlice: Record<string, LMEQuestion[]> = {};
  for (const q of all) {
    const s = sliceOf(q);
    if (!s) continue;
    (bySlice[s] ??= []).push(q);
  }
  const out: LMEQuestion[] = [];
  for (const s of TARGET_SLICES) {
    out.push(...(bySlice[s] ?? []).slice(0, perSlice));
  }
  return out;
}

/** Parse "2023/04/10 (Mon) 23:07" into a Date. */
export function parseLMEDate(s: string): Date {
  // Strip " (Mon)" etc.
  const cleaned = s.replace(/\s*\([A-Z][a-z]+\)\s*/, " ");
  // "2023/04/10 23:07" → "2023-04-10T23:07:00Z"
  const m = cleaned.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
  if (!m) return new Date(cleaned);
  const [, y, mo, d, h, mi] = m;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:00Z`);
}

export interface IngestTurn {
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

/** Flatten a question's haystack sessions into chronological turns with timestamps. */
export function flattenHaystack(q: LMEQuestion): IngestTurn[] {
  const turns: IngestTurn[] = [];
  for (let sIdx = 0; sIdx < q.haystack_sessions.length; sIdx++) {
    const base = parseLMEDate(q.haystack_dates[sIdx] ?? q.question_date);
    const session = q.haystack_sessions[sIdx] ?? [];
    for (let tIdx = 0; tIdx < session.length; tIdx++) {
      // Space turns ~30s apart within a session for monotonic ordering.
      const ts = new Date(base.getTime() + tIdx * 30_000);
      turns.push({
        role: session[tIdx]!.role,
        content: session[tIdx]!.content,
        timestamp: ts,
      });
    }
  }
  return turns;
}

/**
 * Deterministic pseudo-random: seedable so the distractor set is stable
 * across reruns for the same (question_id, K). A hash of the question_id
 * keeps distractors reproducible without bleeding state across questions.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Inject K distractor turns pulled from OTHER questions' haystacks into this
 * question's turn stream. Timestamps are set to fall WITHIN the real haystack
 * window (not before/after) so they compete with gold evidence on recency.
 *
 * Goal: stress-test retrieval under noise. Raw-vector should decay fastest;
 * structured approaches should hold up because importance/entity/SPO signals
 * filter distractors out before ranking.
 */
export function injectDistractors(
  q: LMEQuestion,
  allQuestions: LMEQuestion[],
  k: number,
): IngestTurn[] {
  const base = flattenHaystack(q);
  if (k <= 0 || base.length === 0) return base;

  const rng = mulberry32(hashSeed(q.question_id));
  const others = allQuestions.filter((x) => x.question_id !== q.question_id);
  if (others.length === 0) return base;

  // Collect a pool of candidate distractor contents from other questions'
  // haystacks. Prefer long-ish turns (≥40 chars) — filler like "ok" adds no
  // signal either way.
  const pool: string[] = [];
  for (const o of others) {
    for (const session of o.haystack_sessions) {
      for (const t of session) {
        if (t.content.length >= 40) pool.push(t.content);
      }
    }
  }
  if (pool.length === 0) return base;

  const tMin = base[0]!.timestamp.getTime();
  const tMax = base[base.length - 1]!.timestamp.getTime();
  const span = Math.max(1, tMax - tMin);

  const out = base.slice();
  for (let i = 0; i < k; i++) {
    const content = pool[Math.floor(rng() * pool.length)]!;
    const ts = new Date(tMin + Math.floor(rng() * span));
    out.push({ role: "user", content, timestamp: ts });
  }
  // Re-sort chronologically so ingestion order is preserved.
  out.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return out;
}
