import { getPool } from "../src/db/client.ts";
import { APPROACHES, retrieve } from "../src/dispatch.ts";
import { answerFromRetrieved } from "../src/eval/answer.ts";

/**
 * Side-by-side demo. Run after `bun run bench` has ingested at least one agent.
 *
 *   AGENT_ID=<question_id> QUERY="what was the first issue after my service?" bun run demo
 */
async function main() {
  const agentId = process.env.AGENT_ID;
  const query = process.env.QUERY;
  const qdate = process.env.QUERY_DATE
    ? new Date(process.env.QUERY_DATE)
    : new Date();

  if (!agentId || !query) {
    console.error("Set AGENT_ID and QUERY env vars.");
    process.exit(1);
  }

  console.log(`Agent: ${agentId}`);
  console.log(`Query: ${query}`);
  console.log(`Date:  ${qdate.toISOString()}\n`);

  for (const approach of APPROACHES) {
    const t0 = Date.now();
    const retrieved = await retrieve(approach, agentId, query, qdate, 5);
    const answer = await answerFromRetrieved(query, qdate, retrieved);
    const ms = Date.now() - t0;

    console.log(`── ${approach} (${ms}ms) ──`);
    console.log(`Answer: ${answer}`);
    console.log(`Retrieved:`);
    retrieved.forEach((r, i) => {
      console.log(
        `  [${i + 1}] (${r.memory.event_time.toISOString().slice(0, 10)}) ${r.memory.content.slice(0, 120)}`,
      );
    });
    console.log();
  }

  await getPool().end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
