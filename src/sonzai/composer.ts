import { chatJSON, COMPOSE_MODEL } from "../llm.ts";
import type {
  ComposedRow,
  ComposerPlan,
  EmpathKind,
  LensBundle,
  LensName,
} from "../types.ts";

/**
 * Composer — Gemini Pro reconciliation pass.
 *
 * Takes the five lens outputs + a short list of recent priors (with DB ids)
 * and produces a commit plan: which rows to insert, which prior rows to
 * mark superseded. This is where the judgment lives — the lenses propose,
 * the composer disposes.
 *
 * Why Pro and not Flash-Lite: the lenses sometimes disagree (Empath says
 * "commitment", Cartographer emits a (user, will_run, 7am) triple, Librarian
 * flags it as "updates" a prior commitment). Reconciling those views into a
 * single canonical row-set is a reasoning task where Pro's headroom matters.
 * It's one call per turn, so latency cost is bounded.
 */

export interface ComposerPrior {
  id: number;
  content: string;
  topic?: string | null;
  subject?: string | null;
  predicate?: string | null;
  object?: string | null;
  kind?: EmpathKind | null;
}

export interface ComposerInput {
  turn_content: string;
  turn_timestamp: string; // ISO
  lenses: LensBundle;
  priors: ComposerPrior[];
}

const SYSTEM = `You are the Composer.

Five extraction lenses have processed a single conversation turn. You also
see a short list of the agent's recent prior memories with their database ids.
Your job is to reconcile the five views into a single commit plan: the
minimal set of canonical rows to insert, and the ids of any prior rows that
those inserts supersede.

Output strict JSON:
{
  "commits": [
    {
      "content": string,            // canonical, self-contained sentence
      "lens": "archivist" | "empath" | "cartographer" | "timekeeper" | "composed",
      "level": 1,                   // always 1 (atomic fact); level 2 summaries are produced by the consolidator
      "importance": 0..1,
      "event_time": ISO-8601,       // use Timekeeper's anchor when applicable, else turn_timestamp
      "entities": string[],         // lowercase canonical entities
      "kind"?: "preference"|"goal"|"commitment"|"aversion"|"mood"|"fact",
      "valence"?: -1..1,
      "subject"?: string,
      "predicate"?: string,
      "object"?: string,
      "topic"?: string,
      "supersedes_id"?: number      // db id of the prior row this commit replaces
    }
  ],
  "supersede_ids": number[]          // db ids to mark superseded_at (dedup against commits[*].supersedes_id)
}

Reconciliation rules:
- Deduplicate across lenses. If Archivist and Cartographer cover the same fact, emit ONE row using the Cartographer triple (its SPO fields make it more queryable).
- Prefer the most specific Timekeeper anchor for event_time. Default to turn_timestamp if no anchor applies.
- When Librarian flagged "updates" or "contradicts", match against the priors list and set supersedes_id + add that id to supersede_ids.
- Never emit a row that merely restates a prior without new information. Skip reinforces-only tags.
- Preserve emotionally-charged statements (Empath kinds: preference/goal/commitment/aversion) as their own rows even if Archivist also captured the underlying fact — they serve different retrieval paths.
- Keep the plan minimal. If the turn has no durable content, emit commits: [].
- lens = "composed" means the commit is a composer-authored merge that doesn't correspond 1:1 to any single lens output.
- For pure SPO triples, set lens = "cartographer" and fill subject/predicate/object.
- For affect/intent rows, set lens = "empath" and fill kind/valence.
- For plain atomic facts with no SPO/affect, set lens = "archivist".`;

const VALID_LENSES: LensName[] = [
  "archivist",
  "empath",
  "cartographer",
  "timekeeper",
  "librarian",
  "composed",
];

const VALID_KINDS: EmpathKind[] = [
  "preference",
  "goal",
  "commitment",
  "aversion",
  "mood",
  "fact",
];

export async function compose(input: ComposerInput): Promise<ComposerPlan> {
  const prompt = buildPrompt(input);
  const raw = await chatJSON<any>(COMPOSE_MODEL, SYSTEM, prompt);

  const commitsRaw: any[] = Array.isArray(raw.commits) ? raw.commits : [];
  const commits: ComposedRow[] = commitsRaw
    .filter((c) => typeof c?.content === "string" && c.content.trim())
    .map((c) => {
      const lens: LensName = VALID_LENSES.includes(c.lens)
        ? c.lens
        : "composed";
      const kind: EmpathKind | undefined = VALID_KINDS.includes(c.kind)
        ? c.kind
        : undefined;
      return {
        content: String(c.content).trim(),
        lens,
        level: 1,
        importance: clamp01(Number(c.importance ?? 0.5)),
        event_time:
          typeof c.event_time === "string" && c.event_time
            ? c.event_time
            : input.turn_timestamp,
        entities: Array.isArray(c.entities)
          ? c.entities
              .filter((e: unknown): e is string => typeof e === "string")
              .map((e: string) => e.toLowerCase().trim())
          : [],
        kind: kind ?? null,
        valence:
          typeof c.valence === "number" && Number.isFinite(c.valence)
            ? clampPm1(c.valence)
            : null,
        subject:
          typeof c.subject === "string" ? c.subject.toLowerCase().trim() : null,
        predicate:
          typeof c.predicate === "string"
            ? c.predicate.toLowerCase().trim().replace(/\s+/g, "_")
            : null,
        object:
          typeof c.object === "string" ? c.object.toLowerCase().trim() : null,
        topic:
          typeof c.topic === "string" ? c.topic.toLowerCase().trim() : null,
        supersedes_id:
          typeof c.supersedes_id === "number" &&
          Number.isFinite(c.supersedes_id)
            ? Math.floor(c.supersedes_id)
            : null,
      };
    });

  const supersede_ids: number[] = Array.isArray(raw.supersede_ids)
    ? raw.supersede_ids
        .filter((n: unknown) => typeof n === "number" && Number.isFinite(n))
        .map((n: number) => Math.floor(n))
    : [];

  // Merge supersedes_id from individual commits into the top-level list.
  for (const c of commits) {
    if (
      typeof c.supersedes_id === "number" &&
      !supersede_ids.includes(c.supersedes_id)
    ) {
      supersede_ids.push(c.supersedes_id);
    }
  }

  // Filter supersede_ids to only those present in priors (guard against hallucinated ids).
  const priorIdSet = new Set(input.priors.map((p) => p.id));
  const safeSupersede = supersede_ids.filter((id) => priorIdSet.has(id));

  return { commits, supersede_ids: safeSupersede };
}

function buildPrompt(input: ComposerInput): string {
  const { lenses, priors } = input;

  const archivistBlock =
    lenses.archivist.length > 0
      ? lenses.archivist
          .map(
            (f, i) =>
              `  [A${i}] ${f.content}  (importance=${f.importance.toFixed(2)}, confidence=${f.confidence.toFixed(2)})`,
          )
          .join("\n")
      : "  (none)";

  const empathBlock =
    lenses.empath.length > 0
      ? lenses.empath
          .map(
            (f, i) =>
              `  [E${i}] (${f.kind}, valence=${f.valence.toFixed(2)}) ${f.content}`,
          )
          .join("\n")
      : "  (none)";

  const cartographerBlock =
    lenses.cartographer.length > 0
      ? lenses.cartographer
          .map(
            (t, i) =>
              `  [C${i}] (${t.subject}, ${t.predicate}, ${t.object}) — ${t.content}`,
          )
          .join("\n")
      : "  (none)";

  const timekeeperBlock =
    lenses.timekeeper.length > 0
      ? lenses.timekeeper
          .map(
            (a, i) =>
              `  [T${i}] event_time=${a.event_time} (${a.precision}, anchor="${a.anchor_phrase}") — ${a.content}`,
          )
          .join("\n")
      : "  (none)";

  const librarianBlock =
    lenses.librarian.length > 0
      ? lenses.librarian
          .map(
            (l, i) =>
              `  [L${i}] topic=${l.topic}, novelty=${l.novelty}${l.may_supersede_content ? `, may_supersede="${l.may_supersede_content}"` : ""} — ${l.content}`,
          )
          .join("\n")
      : "  (none)";

  const priorsBlock =
    priors.length > 0
      ? priors
          .map(
            (p) =>
              `  [id=${p.id}] ${p.topic ? `(${p.topic}) ` : ""}${p.subject && p.predicate ? `(${p.subject}, ${p.predicate}, ${p.object}) ` : ""}${p.content}`,
          )
          .join("\n")
      : "  (no priors)";

  return `Turn timestamp: ${input.turn_timestamp}
Turn content:
${input.turn_content}

--- Lens outputs ---

Archivist (literal facts):
${archivistBlock}

Empath (affect/intent):
${empathBlock}

Cartographer (SPO triples):
${cartographerBlock}

Timekeeper (event-time anchors):
${timekeeperBlock}

Librarian (topic + novelty):
${librarianBlock}

--- Recent priors (candidates for supersede) ---
${priorsBlock}

Return JSON only.`;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  return Math.max(0, Math.min(1, x));
}

function clampPm1(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(-1, Math.min(1, x));
}
