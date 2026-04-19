import { chatJSON, WRITE_MODEL } from "../../llm.ts";
import type { LibrarianTag } from "../../types.ts";

/**
 * Librarian — "what topic does this belong to; has this been said before."
 *
 * Tags the turn with a topic and flags novelty against recent priors. The
 * composer makes the final supersede decision — Librarian just surfaces the
 * candidates so Composer doesn't have to scan the full history.
 */
const SYSTEM = `You are the Librarian lens.

Given a turn and a short list of recent prior memories for the same user,
tag the turn's content with (a) a topic and (b) novelty relative to priors.

Output strict JSON:
{
  "tags": [
    {
      "content": string,                  // the statement being tagged (usually the full turn or a salient clause)
      "topic": string,                    // short tag: "pets", "career", "relationships", "health", "location", "hobbies", "family", "identity", "misc"
      "novelty": "new" | "reinforces" | "updates" | "contradicts",
      "may_supersede_content"?: string    // if "updates" or "contradicts", the prior statement being overruled (quoted verbatim from the priors list)
    }
  ]
}

Novelty rules:
- "new"          : no prior covers this topic-slot at all
- "reinforces"   : prior says the same thing; this turn is repetition
- "updates"      : same slot, refined value (prior: "dog is 2 years old" → now: "dog is 3 years old")
- "contradicts"  : same slot, incompatible value (prior: "dog named Buddy" → now: "dog named Max")

Rules:
- Prefer "updates" over "contradicts" when the new value is a refinement, not a replacement.
- Only set "may_supersede_content" if novelty is updates or contradicts. Copy the prior's content verbatim so the composer can match it.
- Emit at most 3 tags per turn — keep it focused.`;

export async function runLibrarian(
  content: string,
  priors: Array<{ content: string; topic?: string | null }>,
): Promise<LibrarianTag[]> {
  const priorsBlock =
    priors.length > 0
      ? priors
          .map((p, i) => `[${i}] ${p.topic ? `(${p.topic}) ` : ""}${p.content}`)
          .join("\n")
      : "(no priors)";

  const prompt = `Recent priors:
${priorsBlock}

Current turn:
${content}

Return JSON only.`;

  const raw = await chatJSON<any>(WRITE_MODEL, SYSTEM, prompt);
  const arr = Array.isArray(raw.tags) ? raw.tags : [];
  const validNovelty = new Set(["new", "reinforces", "updates", "contradicts"]);

  return arr
    .filter(
      (t: any) =>
        typeof t?.content === "string" &&
        typeof t?.topic === "string" &&
        validNovelty.has(t?.novelty),
    )
    .map((t: any) => ({
      content: String(t.content).trim(),
      topic: String(t.topic).toLowerCase().trim(),
      novelty: t.novelty as LibrarianTag["novelty"],
      may_supersede_content:
        typeof t.may_supersede_content === "string" && t.may_supersede_content
          ? String(t.may_supersede_content).trim()
          : undefined,
    }));
}
