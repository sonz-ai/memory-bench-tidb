/**
 * Per-model USD pricing for the memory-bench.
 *
 * Prices are per 1M tokens (input / output). Embedding is per 1M input tokens.
 * Numbers are taken from Google's published Gemini pricing as of the bench
 * date; override via env if the preview-tier rates have shifted.
 *
 * We keep raw tokens in the runs table and compute $ at summary time so we
 * can reprice without re-running.
 */
import type { TokenTally } from "./llm.ts";

export interface ModelPrice {
  input_per_m: number;
  output_per_m: number;
  embed_per_m?: number;
}

const ENV = (name: string, fallback: number): number => {
  const v = process.env[name];
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const PRICING: Record<string, ModelPrice> = {
  "gemini-3.1-flash-lite-preview": {
    input_per_m: ENV("PRICE_FLASH_LITE_IN", 0.1),
    output_per_m: ENV("PRICE_FLASH_LITE_OUT", 0.4),
  },
  "gemini-3.1-flash-preview": {
    input_per_m: ENV("PRICE_FLASH_IN", 0.3),
    output_per_m: ENV("PRICE_FLASH_OUT", 2.5),
  },
  "gemini-3.1-pro-preview": {
    input_per_m: ENV("PRICE_PRO_IN", 1.25),
    output_per_m: ENV("PRICE_PRO_OUT", 10),
  },
  "gemini-embedding-001": {
    input_per_m: 0,
    output_per_m: 0,
    embed_per_m: ENV("PRICE_EMBED", 0.15),
  },
};

const FALLBACK: ModelPrice = {
  input_per_m: ENV("PRICE_DEFAULT_IN", 0.5),
  output_per_m: ENV("PRICE_DEFAULT_OUT", 2),
  embed_per_m: ENV("PRICE_DEFAULT_EMBED", 0.15),
};

export function priceFor(model: string): ModelPrice {
  return PRICING[model] ?? FALLBACK;
}

/** Total USD cost for a TokenTally, using per-model pricing. */
export function costUsd(tally: TokenTally): number {
  let total = 0;
  for (const [model, m] of Object.entries(tally.by_model)) {
    const p = priceFor(model);
    total += (m.prompt_tokens / 1_000_000) * p.input_per_m;
    total += (m.completion_tokens / 1_000_000) * p.output_per_m;
    total += (m.embed_tokens / 1_000_000) * (p.embed_per_m ?? 0);
  }
  return total;
}

/** Cost from flat totals (when we've lost per-model resolution, e.g. in SQL aggregates). */
export function costFromFlat(
  tokensIn: number,
  tokensOut: number,
  embedTokens: number,
  opts: { chatModel?: string; embedModel?: string } = {},
): number {
  const chat = priceFor(opts.chatModel ?? "gemini-3.1-flash-lite-preview");
  const emb = priceFor(opts.embedModel ?? "gemini-embedding-001");
  return (
    (tokensIn / 1_000_000) * chat.input_per_m +
    (tokensOut / 1_000_000) * chat.output_per_m +
    (embedTokens / 1_000_000) * (emb.embed_per_m ?? 0)
  );
}
