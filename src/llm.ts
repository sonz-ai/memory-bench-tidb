/**
 * Gemini-backed LLM + embedding client. Same exported surface as the earlier
 * OpenAI version so callers don't change: chatJSON, chatText, embed.
 *
 * We hit the REST API directly (v1beta) instead of the SDK because the SDK
 * version we have doesn't cleanly expose `outputDimensionality` — and we need
 * 1536-dim embeddings to match the existing TiDB VECTOR(1536) schema.
 *
 * Also: every LLM + embed call reports tokens into an AsyncLocalStorage
 * scope so callers can attribute ingest vs retrieval vs judge spend per
 * (approach, question_id) without passing a counter through every function.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";

export interface TokenTally {
  // LLM generate calls (chat).
  prompt_tokens: number;
  completion_tokens: number;
  // Embedding calls (approx: chars / 4 — Gemini embed doesn't reliably
  // report usage, but this is the same heuristic OpenAI tiktoken would give
  // for English text, and it's consistent across approaches).
  embed_tokens: number;
  // Per-model breakdown so we can reprice after the fact.
  by_model: Record<
    string,
    { prompt_tokens: number; completion_tokens: number; embed_tokens: number }
  >;
}

export function emptyTally(): TokenTally {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    embed_tokens: 0,
    by_model: {},
  };
}

const tokenCtx = new AsyncLocalStorage<TokenTally>();

export function withTokenScope<T>(fn: () => Promise<T>): Promise<{
  value: T;
  tally: TokenTally;
}> {
  const tally = emptyTally();
  return tokenCtx.run(tally, async () => {
    const value = await fn();
    return { value, tally };
  });
}

function recordChat(
  model: string,
  promptTokens: number,
  completionTokens: number,
): void {
  const t = tokenCtx.getStore();
  if (!t) return;
  t.prompt_tokens += promptTokens;
  t.completion_tokens += completionTokens;
  const m = (t.by_model[model] ??= {
    prompt_tokens: 0,
    completion_tokens: 0,
    embed_tokens: 0,
  });
  m.prompt_tokens += promptTokens;
  m.completion_tokens += completionTokens;
}

function recordEmbed(model: string, embedTokens: number): void {
  const t = tokenCtx.getStore();
  if (!t) return;
  t.embed_tokens += embedTokens;
  const m = (t.by_model[model] ??= {
    prompt_tokens: 0,
    completion_tokens: 0,
    embed_tokens: 0,
  });
  m.embed_tokens += embedTokens;
}

function approxTokens(text: string): number {
  // chars/4 — OpenAI's canonical heuristic, close enough for cross-approach
  // comparison. We only need parity, not accuracy to 3 decimals.
  return Math.max(1, Math.ceil(text.length / 4));
}

function apiKey(): string {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error("Missing GEMINI_API_KEY");
  return k;
}

export const WRITE_MODEL =
  process.env.WRITE_MODEL ?? "gemini-3.1-flash-lite-preview";
export const ANSWER_MODEL =
  process.env.ANSWER_MODEL ?? "gemini-3.1-flash-lite-preview";
// Composer uses Pro — reconciling five lens outputs + priors is a judgment
// task where quality matters more than latency. One call per turn.
export const COMPOSE_MODEL =
  process.env.COMPOSE_MODEL ?? "gemini-3.1-pro-preview";
// Judge stays on a stronger model so grading remains trustworthy.
export const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "gemini-3.1-pro-preview";
export const EMBED_MODEL = process.env.EMBED_MODEL ?? "gemini-embedding-001";
export const EMBED_DIM = parseInt(process.env.EMBED_DIM ?? "1536", 10);

interface GenerateContentResp {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  promptFeedback?: unknown;
  error?: { message?: string; code?: number };
}

async function generate(
  model: string,
  system: string,
  user: string,
  opts: { json: boolean; temperature?: number } = { json: false },
): Promise<string> {
  const url = `${API_ROOT}/models/${model}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: {
      temperature: opts.temperature ?? (opts.json ? 0.1 : 0.0),
      ...(opts.json ? { responseMimeType: "application/json" } : {}),
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey(),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini ${model} ${res.status}: ${err.slice(0, 400)}`);
  }

  const json = (await res.json()) as GenerateContentResp;
  if (json.error) throw new Error(`Gemini ${model}: ${json.error.message}`);
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error(
      `Gemini ${model}: empty response (${JSON.stringify(json).slice(0, 200)})`,
    );
  }

  // Prefer reported usage; fall back to char/4 approximation when the API
  // omits it (some preview models do).
  const promptTokens =
    json.usageMetadata?.promptTokenCount ??
    approxTokens(system) + approxTokens(user);
  const completionTokens =
    json.usageMetadata?.candidatesTokenCount ?? approxTokens(text);
  recordChat(model, promptTokens, completionTokens);

  return text;
}

export async function chatJSON<T>(
  model: string,
  system: string,
  user: string,
): Promise<T> {
  const text = await generate(model, system, user, { json: true });
  try {
    return JSON.parse(text) as T;
  } catch {
    // Occasionally models wrap JSON in ``` fences even with JSON mime type.
    const stripped = text
      .replace(/^\s*```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();
    return JSON.parse(stripped) as T;
  }
}

export async function chatText(
  model: string,
  system: string,
  user: string,
): Promise<string> {
  return generate(model, system, user, { json: false });
}

interface EmbedContentResp {
  embedding?: { values: number[] };
  error?: { message?: string };
}

/**
 * Batched embedding. The v1beta embedContent endpoint is single-doc; for a
 * batch we issue N requests in parallel (bounded). Gemini's batchEmbedContents
 * is gated on some models, so single-doc is the safe path.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const CONCURRENCY = parseInt(process.env.EMBED_CONCURRENCY ?? "16", 10);
  const out: number[][] = new Array(texts.length);
  let idx = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= texts.length) return;
      const text = texts[i]!;
      out[i] = await embedOne(text);
      recordEmbed(EMBED_MODEL, approxTokens(text));
    }
  }

  const workers = Array.from(
    { length: Math.min(CONCURRENCY, texts.length) },
    worker,
  );
  await Promise.all(workers);
  return out;
}

async function embedOne(text: string): Promise<number[]> {
  const url = `${API_ROOT}/models/${EMBED_MODEL}:embedContent`;
  const body = {
    content: { parts: [{ text }] },
    taskType: "RETRIEVAL_DOCUMENT",
    outputDimensionality: EMBED_DIM,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey(),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`embed ${EMBED_MODEL} ${res.status}: ${err.slice(0, 400)}`);
  }

  const json = (await res.json()) as EmbedContentResp;
  if (json.error) throw new Error(`embed: ${json.error.message}`);
  const vals = json.embedding?.values;
  if (!Array.isArray(vals)) {
    throw new Error(`embed: no embedding in response`);
  }
  return vals;
}
