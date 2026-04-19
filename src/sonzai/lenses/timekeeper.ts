import { chatJSON, WRITE_MODEL } from "../../llm.ts";
import type { TimekeeperAnchor } from "../../types.ts";

/**
 * Timekeeper — "when, and in what order."
 *
 * Resolves temporal references into absolute event_time. The retriever's
 * temporal-window boost lives or dies on this lens. Without it, event_time
 * silently falls back to ingestion time and the `temporal` slice collapses.
 */
const SYSTEM = `You are the Timekeeper lens.

Resolve temporal references in a single turn into absolute event times,
relative to the turn's timestamp.

Output strict JSON:
{
  "anchors": [
    {
      "content": string,       // the specific statement this anchor applies to
      "event_time": ISO-8601,  // absolute datetime with timezone
      "precision": "day" | "week" | "month" | "approximate",
      "anchor_phrase": string  // the phrase resolved ("last Tuesday", "after the move")
    }
  ]
}

Resolution rules:
- "yesterday"          → turn_timestamp - 1 day  (precision: day)
- "last Tuesday"       → Tuesday of previous week relative to turn_timestamp  (precision: day)
- "last month"         → midpoint of previous calendar month  (precision: month)
- "a few weeks ago"    → turn_timestamp - 3 weeks  (precision: approximate)
- "after the move"     → only if "the move" is datable from context; otherwise skip
- Pure present tense / preferences ("I like X") → single anchor at turn_timestamp (precision: day)

Rules:
- One anchor per dated statement. A turn with multiple dated statements produces multiple anchors.
- Skip if the turn has no temporal signal beyond "now" (return empty anchors — caller will fall back to turn_timestamp).
- ISO-8601 must include timezone (use turn_timestamp's zone, default Z).`;

export async function runTimekeeper(
  content: string,
  turnTimestamp: Date,
): Promise<TimekeeperAnchor[]> {
  const prompt = `Turn timestamp: ${turnTimestamp.toISOString()}
Turn content:
${content}

Return JSON only.`;

  const raw = await chatJSON<any>(WRITE_MODEL, SYSTEM, prompt);
  const arr = Array.isArray(raw.anchors) ? raw.anchors : [];
  const validPrecisions = new Set(["day", "week", "month", "approximate"]);

  return arr
    .filter(
      (a: any) =>
        typeof a?.content === "string" &&
        typeof a?.event_time === "string" &&
        a.content.trim(),
    )
    .map((a: any) => ({
      content: String(a.content).trim(),
      event_time: String(a.event_time),
      precision: validPrecisions.has(a.precision) ? a.precision : "approximate",
      anchor_phrase:
        typeof a.anchor_phrase === "string" ? a.anchor_phrase : "now",
    }));
}
