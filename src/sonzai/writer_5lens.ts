import { getPool, vecLiteral } from "../db/client.ts";
import { embed } from "../llm.ts";
import type {
  Turn,
  ComposedRow,
  CartographerTriple,
  LibrarianTag,
} from "../types.ts";
import { runCartographer } from "./lenses/cartographer.ts";
import { runLibrarian } from "./lenses/librarian.ts";

const APPROACH = "spo_supersede";
const PRIORS_LIMIT = 12;

/**
 * 2-lens writer with deterministic merge.
 *
 * We kept the file name (spo_supersede) for wire compatibility with the
 * schema + dispatch tables, but the pipeline is now just:
 *
 *   Cartographer lens + Librarian lens (in parallel)
 *     ↓
 *   Deterministic merge in code (no LLM composer call):
 *     - SPO collision: (subject, predicate) match + different object → supersede
 *     - Librarian novelty=updates|contradicts + fuzzy content match → supersede
 *     ↓
 *   Bulk INSERT + UPDATE superseded_at in one transaction
 *
 * Why deterministic: the composer (Gemini Pro) was the slowest call per turn
 * and its main value was reconciling conflicting lens outputs. With only two
 * lenses that don't actually conflict (Cartographer does triples, Librarian
 * does topic+novelty tags), the reconciliation is trivial SQL logic.
 *
 * Speed: ~3× faster than the 5-lens variant. Same dedup quality on the
 * knowledge_update slice, since the SPO collision rule is what drove those wins.
 */
export async function writeSonzai5Lens(
  agentId: string,
  turn: Turn,
): Promise<void> {
  const pool = getPool();

  // Concurrent: priors fetch + cartographer + raw-turn embedding.
  const priorsPromise = fetchPriors(agentId, PRIORS_LIMIT);
  const rawEmbPromise = embed([turn.content]);
  const cartographerPromise = safeArray(
    runCartographer(turn.content, turn.timestamp),
    "cartographer",
  );

  // Librarian needs priors as context.
  const priors = await priorsPromise;
  const [cartographer, librarian] = await Promise.all([
    cartographerPromise,
    safeArray(
      runLibrarian(
        turn.content,
        priors.map((x) => ({ content: x.content, topic: x.topic })),
      ),
      "librarian",
    ),
  ]);

  // Merge.
  const plan = deterministicMerge({
    turnContent: turn.content,
    turnTimestamp: turn.timestamp,
    cartographer,
    librarian,
    priors,
  });

  // Embed composed rows in parallel with raw-turn write.
  const composedEmbsPromise =
    plan.commits.length > 0
      ? embed(plan.commits.map((c) => c.content))
      : Promise.resolve([] as number[][]);

  const [rawEmb] = await rawEmbPromise;

  // Write level-0 raw turn (always — provenance).
  await pool.query(
    `INSERT INTO memories
       (approach, agent_id, level, content, event_time, importance, entities, embedding)
     VALUES (?, ?, 0, ?, ?, ?, ?, ?)`,
    [
      APPROACH,
      agentId,
      turn.content,
      turn.timestamp,
      averageImportance(cartographer),
      JSON.stringify(collectEntities(cartographer)),
      vecLiteral(rawEmb),
    ],
  );

  // Bulk insert commits.
  if (plan.commits.length > 0) {
    const embeddings = await composedEmbsPromise;
    const cols = `(approach, agent_id, level, content, event_time, importance, entities, embedding,
                   lens, subject, predicate, object, valence, kind, topic, supersedes_id)`;
    const rowPh = `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const placeholders = plan.commits.map(() => rowPh).join(", ");
    const values: any[] = [];
    for (let i = 0; i < plan.commits.length; i++) {
      const c = plan.commits[i]!;
      values.push(
        APPROACH,
        agentId,
        c.level,
        c.content,
        new Date(c.event_time),
        c.importance,
        JSON.stringify(c.entities),
        vecLiteral(embeddings[i]!),
        c.lens,
        c.subject,
        c.predicate,
        c.object,
        c.valence,
        c.kind,
        c.topic,
        c.supersedes_id, // already a string (real DB id) by construction
      );
    }
    await pool.query(
      `INSERT INTO memories ${cols} VALUES ${placeholders}`,
      values,
    );
  }

  // Mark supersedes.
  if (plan.supersede_ids.length > 0) {
    const placeholders = plan.supersede_ids.map(() => "?").join(",");
    await pool.query(
      `UPDATE memories
         SET superseded_at = NOW()
       WHERE approach = ?
         AND agent_id = ?
         AND id IN (${placeholders})
         AND superseded_at IS NULL`,
      [APPROACH, agentId, ...plan.supersede_ids],
    );
  }
}

/* -------------------- deterministic merge -------------------- */

interface PriorRow {
  id: string; // real DB id, string to preserve bigint precision
  content: string;
  topic: string | null;
  subject: string | null;
  predicate: string | null;
  object: string | null;
}

interface Plan {
  commits: ComposedRow[];
  supersede_ids: string[];
}

function deterministicMerge(args: {
  turnContent: string;
  turnTimestamp: Date;
  cartographer: CartographerTriple[];
  librarian: LibrarianTag[];
  priors: PriorRow[];
}): Plan {
  const commits: ComposedRow[] = [];
  const supersedeSet = new Set<string>();
  const topicByContent = indexTopics(args.librarian);

  // 1. Cartographer triples — SPO collision detection.
  for (const t of args.cartographer) {
    const commit: ComposedRow = {
      content: t.content,
      lens: "cartographer",
      level: 1,
      importance: t.importance,
      event_time: args.turnTimestamp.toISOString(),
      entities: [t.subject, t.object].filter((e) => e && e !== "user"),
      kind: null,
      valence: null,
      subject: t.subject,
      predicate: t.predicate,
      object: t.object,
      topic: pickTopic(t.content, topicByContent),
      supersedes_id: null,
    };

    // Collision: alive row with same (subject, predicate), different object.
    const collision = args.priors.find(
      (r) =>
        r.subject === t.subject &&
        r.predicate === t.predicate &&
        r.object !== null &&
        r.object !== t.object,
    );
    if (collision) {
      commit.supersedes_id = collision.id as unknown as number; // stored as string; see note in writer
      supersedeSet.add(collision.id);
    }
    commits.push(commit);
  }

  // 2. Librarian tags — fuzzy content supersede for non-SPO contradictions
  //    plus a topic-tagged commit when the lens captured something new.
  for (const tag of args.librarian) {
    if (tag.novelty === "reinforces") continue; // skip duplicates outright

    // Skip if this librarian tag content is already represented by a
    // cartographer commit (avoid row bloat for the same underlying fact).
    const alreadyCovered = commits.some(
      (c) =>
        c.lens === "cartographer" &&
        normalizeContent(c.content) === normalizeContent(tag.content),
    );
    if (
      alreadyCovered &&
      tag.novelty !== "updates" &&
      tag.novelty !== "contradicts"
    ) {
      continue;
    }

    const commit: ComposedRow = {
      content: tag.content,
      lens: "librarian",
      level: 1,
      importance: 0.6,
      event_time: args.turnTimestamp.toISOString(),
      entities: [],
      kind: null,
      valence: null,
      subject: null,
      predicate: null,
      object: null,
      topic: tag.topic,
      supersedes_id: null,
    };

    if (
      (tag.novelty === "updates" || tag.novelty === "contradicts") &&
      tag.may_supersede_content
    ) {
      const victim = fuzzyMatch(tag.may_supersede_content, args.priors);
      if (victim && !supersedeSet.has(victim.id)) {
        commit.supersedes_id = victim.id as unknown as number;
        supersedeSet.add(victim.id);
      }
    }
    commits.push(commit);
  }

  return { commits, supersede_ids: Array.from(supersedeSet) };
}

function indexTopics(tags: LibrarianTag[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of tags) m.set(normalizeContent(t.content), t.topic);
  return m;
}

function pickTopic(
  content: string,
  topicByContent: Map<string, string>,
): string | null {
  const n = normalizeContent(content);
  const direct = topicByContent.get(n);
  if (direct) return direct;
  for (const [k, topic] of topicByContent) {
    if (k.includes(n) || n.includes(k)) return topic;
  }
  return null;
}

function fuzzyMatch(target: string, priors: PriorRow[]): PriorRow | undefined {
  const t = normalizeContent(target);
  if (!t) return undefined;
  const exact = priors.find((r) => normalizeContent(r.content) === t);
  if (exact) return exact;
  const sub = priors.find((r) => {
    const rn = normalizeContent(r.content);
    return rn.includes(t) || t.includes(rn);
  });
  if (sub) return sub;
  const targetTokens = new Set(tokenize(t));
  let best: { r: PriorRow; overlap: number } | null = null;
  for (const r of priors) {
    const rt = new Set(tokenize(normalizeContent(r.content)));
    let overlap = 0;
    for (const tok of targetTokens) if (rt.has(tok)) overlap++;
    const ratio = overlap / Math.max(1, targetTokens.size);
    if (ratio >= 0.6 && (!best || ratio > best.overlap)) {
      best = { r, overlap: ratio };
    }
  }
  return best?.r;
}

function normalizeContent(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s: string): string[] {
  return s.split(/\s+/).filter((t) => t.length > 2);
}

/* -------------------- DB helpers -------------------- */

async function fetchPriors(
  agentId: string,
  limit: number,
): Promise<PriorRow[]> {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT id, content, topic, subject, predicate, object
       FROM memories
      WHERE approach = ?
        AND agent_id = ?
        AND level = 1
        AND superseded_at IS NULL
      ORDER BY event_time DESC
      LIMIT ?`,
    [APPROACH, agentId, limit],
  );
  return (rows as any[]).map((r) => ({
    id: String(r.id),
    content: String(r.content ?? ""),
    topic: r.topic ?? null,
    subject: r.subject ?? null,
    predicate: r.predicate ?? null,
    object: r.object ?? null,
  }));
}

async function safeArray<T>(p: Promise<T[]>, label: string): Promise<T[]> {
  try {
    return await p;
  } catch (err: any) {
    console.warn(
      `[2lens] lens ${label} failed: ${err?.message?.slice(0, 120)}`,
    );
    return [];
  }
}

function collectEntities(triples: CartographerTriple[]): string[] {
  const set = new Set<string>();
  for (const t of triples) {
    if (t.subject && t.subject !== "user") set.add(t.subject);
    if (t.object) set.add(t.object);
  }
  return Array.from(set);
}

function averageImportance(items: { importance: number }[]): number {
  if (items.length === 0) return 0.3;
  return items.reduce((s, x) => s + x.importance, 0) / items.length;
}
