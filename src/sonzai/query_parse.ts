import { chatJSON, WRITE_MODEL } from "../llm.ts";

export interface ParsedQuery {
  /** Canonicalized entities to match in memories.entities (lowercase). */
  entities: string[];
  /** Temporal window extracted from phrases like "last Tuesday", "last month". Null if none. */
  time_start: string | null;
  time_end: string | null;
  /** Query keywords for full-text / LIKE matching. */
  keywords: string[];
  /** Query rewritten as a declarative statement for embedding (HyDE-lite). */
  hyde: string;
}

const SYSTEM = `Parse a user question about the user's own past into retrieval filters.
Output strict JSON:
{
  "entities": string[]   // proper nouns or concrete objects mentioned in the question, lowercase
  "time_start": ISO-8601 | null,
  "time_end":   ISO-8601 | null,
  "keywords": string[]   // 3-8 salient content words
  "hyde": string         // the question rewritten as a declarative statement of what the answer would look like, for embedding similarity
}

Temporal rules:
- "last Tuesday" → Tuesday of the previous week relative to question_date
- "last month" → the calendar month before question_date's month
- "after March 15" → time_start = 2026-03-15, time_end = null
- "first time" / "the first X" → time_start = very old (use "1970-01-01"), time_end = question_date (we want to search all of history)
- If no temporal phrase, both null.`;

export async function parseQuery(
  question: string,
  questionDate: Date,
): Promise<ParsedQuery> {
  const out = await chatJSON<any>(
    WRITE_MODEL,
    SYSTEM,
    `Question date: ${questionDate.toISOString()}\nQuestion: ${question}\n\nReturn JSON only.`,
  );
  return {
    entities: Array.isArray(out.entities)
      ? out.entities
          .filter((e: unknown): e is string => typeof e === "string")
          .map((e: string) => e.toLowerCase())
      : [],
    time_start: typeof out.time_start === "string" ? out.time_start : null,
    time_end: typeof out.time_end === "string" ? out.time_end : null,
    keywords: Array.isArray(out.keywords)
      ? out.keywords.filter((k: unknown): k is string => typeof k === "string")
      : [],
    hyde:
      typeof out.hyde === "string" && out.hyde.length > 0 ? out.hyde : question,
  };
}
