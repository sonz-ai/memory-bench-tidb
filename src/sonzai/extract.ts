import { chatJSON, WRITE_MODEL } from "../llm.ts";
import type { WriteExtraction } from "../types.ts";

/**
 * Single LLM call per turn extracts all four write-time signals that matter:
 *   - importance  (0..1): should this memory survive decay?
 *   - event_time  (ISO): WHEN did this happen (per the content), not when we stored it
 *   - entities    : people, things, places — indexed for exact-match recall
 *   - atomic_facts: compressed, self-contained statements (one fact per sentence)
 *
 * This is the "write-heavy" core of Sonzai: we spend LLM tokens at write time so
 * retrieval becomes a SQL query, not a reasoning chain.
 */
const SYSTEM = `You process a single conversation turn into structured memory.

Output strict JSON with this shape:
{
  "importance": number between 0 and 1,
  "event_time": ISO-8601 datetime (when the event/statement in the content HAPPENED; not "now"),
  "entities": array of short canonical entity strings (lowercase, singular, deduped),
  "atomic_facts": array of self-contained sentences — each resolvable in isolation, pronouns replaced, dates made explicit. Empty array if the turn carries no durable fact.
}

Importance guidance:
- 0.1 small talk, greetings, filler
- 0.3 stated preference or opinion
- 0.5 concrete fact about the user's life (job, pet, family, location)
- 0.7 decision, commitment, plan, deadline
- 0.9 identity-level claim, contradiction/update of prior fact, emotional peak

event_time rules:
- If content contains a date/time, resolve it relative to the turn's timestamp.
- If purely present-tense or preference ("I like X"), use the turn's timestamp.
- Always return ISO-8601 with timezone.

Atomic facts must resolve pronouns ("my dog Max" not "he"), name dates ("on 2026-03-15" not "yesterday"), and be self-contained.`;

export async function extractWriteSignals(
  content: string,
  turnTimestamp: Date,
): Promise<WriteExtraction> {
  const prompt = `Turn timestamp: ${turnTimestamp.toISOString()}
Turn content:
${content}

Return JSON only.`;

  const raw = await chatJSON<any>(WRITE_MODEL, SYSTEM, prompt);

  // Coerce defensively — the LLM sometimes drifts on shape.
  const importance = clamp01(Number(raw.importance ?? 0.3));
  const event_time =
    typeof raw.event_time === "string" && raw.event_time.length > 0
      ? raw.event_time
      : turnTimestamp.toISOString();
  const entities = Array.isArray(raw.entities)
    ? raw.entities
        .filter((e: unknown): e is string => typeof e === "string")
        .map((e: string) => e.toLowerCase().trim())
    : [];
  const atomic_facts = Array.isArray(raw.atomic_facts)
    ? raw.atomic_facts.filter(
        (f: unknown): f is string => typeof f === "string",
      )
    : [];

  return { importance, event_time, entities, atomic_facts };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0.3;
  return Math.max(0, Math.min(1, x));
}
