import { chatJSON, WRITE_MODEL } from "../../llm.ts";
import type { EmpathFact, EmpathKind } from "../../types.ts";

/**
 * Empath — "what did the user feel, want, or commit to."
 *
 * Extracts affect, preferences, goals, commitments, aversions. These drive
 * future behavior — and they're exactly what vector-RAG flattens when two
 * near-duplicate embeddings land a preference update alongside its
 * predecessor.
 */
const SYSTEM = `You are the Empath lens.

Extract emotional, preferential, and intentional content from a single turn.
Output strict JSON:
{
  "facts": [
    {
      "content": string,
      "kind": "preference" | "goal" | "commitment" | "aversion" | "mood" | "fact",
      "valence": number between -1 and 1,
      "importance": 0..1
    }
  ]
}

Kinds:
- "preference" : "I like X", "I prefer Y over Z"
- "goal"       : stated intent with no commitment ("I want to run a marathon someday")
- "commitment" : bound promise or scheduled action ("I'll start running at 7am with Sarah")
- "aversion"   : dislike or avoidance ("I hate mornings")
- "mood"       : current emotional state ("I'm exhausted today")
- "fact"       : an emotionally-charged fact worth tagging even if not preference/goal/etc.

Valence: -1 strongly negative, 0 neutral, +1 strongly positive.

Rules:
- Multiple facts per turn are allowed — a mixed statement ("I hate mornings but I promised to run at 7am") produces one aversion and one commitment.
- Empty array if the turn has no emotional or intentional content.
- Do NOT duplicate purely literal facts (Archivist handles those).`;

const VALID_KINDS: EmpathKind[] = [
  "preference",
  "goal",
  "commitment",
  "aversion",
  "mood",
  "fact",
];

export async function runEmpath(
  content: string,
  turnTimestamp: Date,
): Promise<EmpathFact[]> {
  const prompt = `Turn timestamp: ${turnTimestamp.toISOString()}
Turn content:
${content}

Return JSON only.`;

  const raw = await chatJSON<any>(WRITE_MODEL, SYSTEM, prompt);
  const arr = Array.isArray(raw.facts) ? raw.facts : [];
  return arr
    .filter((f: any) => typeof f?.content === "string" && f.content.trim())
    .map((f: any) => {
      const kind: EmpathKind = VALID_KINDS.includes(f.kind) ? f.kind : "fact";
      return {
        content: String(f.content).trim(),
        kind,
        valence: clampPm1(Number(f.valence ?? 0)),
        importance: clamp01(Number(f.importance ?? 0.5)),
      };
    });
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  return Math.max(0, Math.min(1, x));
}

function clampPm1(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(-1, Math.min(1, x));
}
