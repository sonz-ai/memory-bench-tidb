import { chatJSON, WRITE_MODEL } from "../../llm.ts";
import type { CartographerTriple } from "../../types.ts";

/**
 * Cartographer — "who relates to whom, how."
 *
 * Extracts SPO triples. The (subject, predicate, object) shape is what lets
 * a contradiction collapse become a single indexed lookup at write time
 * instead of a rerank at read time. Drift detection lives here.
 */
const SYSTEM = `You are the Cartographer lens.

Extract relationship triples from a single turn. A triple is
(subject, predicate, object) — canonical, indexable, normalized.

Output strict JSON:
{
  "triples": [
    {
      "subject": string,
      "predicate": string,
      "object": string,
      "content": string,
      "importance": 0..1
    }
  ]
}

Canonicalization rules:
- subject: lowercase. Use "user" for the speaker. Otherwise named entity.
- predicate: lowercase, snake_case. Prefer existing verbs: owns, has, lives_in, works_at, named, is_a, likes, studied_at, married_to, moved_to, started, stopped, adopted, knows, owns_dog, owns_cat, etc. Invent new predicates only when no existing one fits.
- object: lowercase. Named entity or canonical noun phrase.
- content: the triple rendered as a natural sentence ("user owns dog named Max").

Rules:
- Multiple triples per turn are allowed.
- Skip when the turn has no relational content (pure preference, pure mood, filler).
- Prefer granular predicates over generic ones: "owns_dog" beats "owns" if the object is a dog.`;

export async function runCartographer(
  content: string,
  _turnTimestamp: Date,
): Promise<CartographerTriple[]> {
  const prompt = `Turn content:
${content}

Return JSON only.`;

  const raw = await chatJSON<any>(WRITE_MODEL, SYSTEM, prompt);
  const arr = Array.isArray(raw.triples) ? raw.triples : [];
  return arr
    .filter(
      (t: any) =>
        typeof t?.subject === "string" &&
        typeof t?.predicate === "string" &&
        typeof t?.object === "string",
    )
    .map((t: any) => {
      const subject = String(t.subject).toLowerCase().trim();
      const predicate = String(t.predicate)
        .toLowerCase()
        .trim()
        .replace(/\s+/g, "_");
      const object = String(t.object).toLowerCase().trim();
      const content =
        typeof t.content === "string" && t.content.trim()
          ? String(t.content).trim()
          : `${subject} ${predicate.replace(/_/g, " ")} ${object}`;
      return {
        subject,
        predicate,
        object,
        content,
        importance: clamp01(Number(t.importance ?? 0.5)),
      };
    });
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  return Math.max(0, Math.min(1, x));
}
