import { chatJSON, WRITE_MODEL } from "../../llm.ts";
import type { ArchivistFact } from "../../types.ts";

/**
 * Archivist — "what happened, literally."
 *
 * The unopinionated stenographer. One row per self-contained, pronoun-
 * resolved, date-explicit fact. No interpretation, no affect, no inference.
 */
const SYSTEM = `You are the Archivist lens.

Extract only literal, verifiable atomic facts from a single conversation turn.
Each fact must be self-contained: pronouns resolved, dates made explicit,
no context needed to understand it in isolation.

Output strict JSON:
{
  "facts": [
    { "content": string, "importance": 0..1, "confidence": 0..1 }
  ]
}

Rules:
- If the turn carries no durable fact (small talk, greeting, filler), return an empty array.
- Do NOT include feelings, preferences, or interpretations — other lenses handle those.
- Importance: 0.1 filler, 0.3 preference, 0.5 concrete life fact, 0.7 decision/plan, 0.9 identity-level.
- Confidence: 1.0 if stated directly, 0.6 if implied, 0.3 if speculative.`;

export async function runArchivist(
  content: string,
  turnTimestamp: Date,
): Promise<ArchivistFact[]> {
  const prompt = `Turn timestamp: ${turnTimestamp.toISOString()}
Turn content:
${content}

Return JSON only.`;

  const raw = await chatJSON<any>(WRITE_MODEL, SYSTEM, prompt);
  const arr = Array.isArray(raw.facts) ? raw.facts : [];
  return arr
    .filter((f: any) => typeof f?.content === "string" && f.content.trim())
    .map((f: any) => ({
      content: String(f.content).trim(),
      importance: clamp01(Number(f.importance ?? 0.5)),
      confidence: clamp01(Number(f.confidence ?? 0.8)),
    }));
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  return Math.max(0, Math.min(1, x));
}
