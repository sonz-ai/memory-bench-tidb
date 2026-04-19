import { getPool, vecLiteral } from "../db/client.ts";
import { embed } from "../llm.ts";
import type { Turn } from "../types.ts";
import { extractWriteSignals } from "./extract.ts";
import { maybeConsolidate } from "./consolidator.ts";

/**
 * Write one turn into the Typed-facts store.
 *
 * Pipeline:
 *   1. Extract {importance, event_time, entities, atomic_facts} via one LLM call.
 *   2. Write the raw turn (level=0) for faithful replay.
 *   3. Write each atomic fact (level=1) with its own embedding — facts are what
 *      retrieval actually scores against. Raw turns are just provenance.
 *   4. Trigger consolidation if the agent has accumulated enough facts.
 */
export async function writeSonzai(agentId: string, turn: Turn): Promise<void> {
  const extraction = await extractWriteSignals(turn.content, turn.timestamp);
  const pool = getPool();

  // Raw turn — level 0. Embed too so we can fall back to semantic recall.
  const [rawEmb] = await embed([turn.content]);
  await pool.query(
    `INSERT INTO memories (approach, agent_id, level, content, event_time, importance, entities, embedding)
     VALUES (?, ?, 0, ?, ?, ?, ?, ?)`,
    [
      "typed_facts",
      agentId,
      turn.content,
      new Date(extraction.event_time),
      extraction.importance,
      JSON.stringify(extraction.entities),
      vecLiteral(rawEmb),
    ],
  );

  // Atomic facts — level 1, the retrieval surface.
  if (extraction.atomic_facts.length > 0) {
    const embeddings = await embed(extraction.atomic_facts);
    for (let i = 0; i < extraction.atomic_facts.length; i++) {
      await pool.query(
        `INSERT INTO memories (approach, agent_id, level, content, event_time, importance, entities, embedding)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
        [
          "typed_facts",
          agentId,
          extraction.atomic_facts[i],
          new Date(extraction.event_time),
          extraction.importance,
          JSON.stringify(extraction.entities),
          vecLiteral(embeddings[i]!),
        ],
      );
    }
  }

  await maybeConsolidate(agentId);
}
