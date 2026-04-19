import { ANSWER_MODEL, chatText, JUDGE_MODEL, chatJSON } from "../llm.ts";
import type { RetrievalResult } from "../types.ts";

/** Ask the LLM to answer using retrieved memories only — closed-book over retrieved evidence. */
export async function answerFromRetrieved(
  question: string,
  questionDate: Date,
  retrieved: RetrievalResult[],
): Promise<string> {
  const evidence = retrieved
    .map(
      (r, i) =>
        `[${i + 1}] (${r.memory.event_time.toISOString()}) ${r.memory.content}`,
    )
    .join("\n");

  const system = `You answer questions using ONLY the evidence retrieved from the user's past conversations.
- If the evidence doesn't support a confident answer, say "I don't know".
- Be concise (one sentence).
- Today is ${questionDate.toISOString().slice(0, 10)}.`;

  const user = `Question: ${question}\n\nEvidence:\n${evidence}\n\nAnswer in one sentence.`;
  return chatText(ANSWER_MODEL, system, user);
}

/** LLM-judge: does `predicted` convey the same answer as `gold`? Returns 0 or 1 + rationale. */
export async function judge(
  question: string,
  gold: string,
  predicted: string,
): Promise<{ score: 0 | 1; rationale: string }> {
  const system = `You grade agent answers against a gold answer.
Return JSON: { "score": 0 | 1, "rationale": string (<= 1 sentence) }.
Score 1 iff predicted conveys the same factual content as gold (paraphrase OK). Otherwise 0.
Score 0 for "I don't know" even if gold is trivial — abstention is a miss.`;
  const user = `Question: ${question}\nGold: ${gold}\nPredicted: ${predicted}\n\nJSON only.`;
  const out = await chatJSON<{ score: number; rationale: string }>(
    JUDGE_MODEL,
    system,
    user,
  );
  const s: 0 | 1 = Number(out.score) === 1 ? 1 : 0;
  return { score: s, rationale: String(out.rationale ?? "") };
}
