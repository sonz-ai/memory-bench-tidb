import type { Approach, RetrievalResult, Turn } from "./types.ts";
import { writeRawVector, retrieveRawVector } from "./baselines/raw_vector.ts";
import {
  writeProgressiveSummary,
  retrieveProgressiveSummary,
  flushProgressiveSummary,
} from "./baselines/progressive_summary.ts";
import {
  writeHierarchical,
  retrieveHierarchical,
} from "./baselines/hierarchical.ts";
import { writeSonzai } from "./sonzai/writer.ts";
import { retrieveSonzai } from "./sonzai/retriever.ts";
import { writeSonzai5Lens } from "./sonzai/writer_5lens.ts";
import { retrieveSonzai5Lens } from "./sonzai/retriever_5lens.ts";

export async function write(
  approach: Approach,
  agentId: string,
  turn: Turn,
): Promise<void> {
  switch (approach) {
    case "raw_vector":
      return writeRawVector(agentId, turn);
    case "progressive_summary":
      return writeProgressiveSummary(agentId, turn);
    case "hierarchical":
      return writeHierarchical(agentId, turn);
    case "typed_facts":
      return writeSonzai(agentId, turn);
    case "spo_supersede":
      return writeSonzai5Lens(agentId, turn);
  }
}

/** End-of-ingest hook: flush any pending batches (progressive_summary). */
export async function flush(
  approach: Approach,
  agentId: string,
): Promise<void> {
  if (approach === "progressive_summary") {
    await flushProgressiveSummary(agentId);
  }
}

export async function retrieve(
  approach: Approach,
  agentId: string,
  question: string,
  questionDate: Date,
  topK = 5,
): Promise<RetrievalResult[]> {
  switch (approach) {
    case "raw_vector":
      return retrieveRawVector(agentId, question, topK);
    case "progressive_summary":
      return retrieveProgressiveSummary(agentId, question, topK);
    case "hierarchical":
      return retrieveHierarchical(agentId, question, topK);
    case "typed_facts":
      return retrieveSonzai({ agentId, question, questionDate, topK });
    case "spo_supersede":
      return retrieveSonzai5Lens({ agentId, question, questionDate, topK });
  }
}

export const APPROACHES: Approach[] = [
  "raw_vector",
  "progressive_summary",
  "hierarchical",
  "typed_facts",
  "spo_supersede",
];
