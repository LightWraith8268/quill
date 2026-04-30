// Voyage AI embeddings wrapper. REST direct (SDK is stale at 0.0.4).
// API: https://docs.voyageai.com/reference/embeddings-api
// Self-throttles to EMBED_RPM and EMBED_TPM. Retries on 429 with backoff.

import type { Config } from "./config.ts";

const ENDPOINT = "https://api.voyageai.com/v1/embeddings";
const HARD_BATCH_CAP = 128;

export type EmbedInputType = "document" | "query";

type VoyageResponse = {
  data: { embedding: number[]; index: number }[];
  usage: { total_tokens: number };
};

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

class Pacer {
  private nextSlot = 0;
  constructor(private readonly minSpacingMs: number) {}
  async wait(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    if (wait > 0) await sleep(wait);
    this.nextSlot = Math.max(now, this.nextSlot) + this.minSpacingMs;
  }
  delay(ms: number): void {
    this.nextSlot = Math.max(this.nextSlot, Date.now() + ms);
  }
}

async function call(
  cfg: Config,
  pacer: Pacer,
  input: string[],
  inputType: EmbedInputType
): Promise<{ vectors: number[][]; tokens: number }> {
  if (!cfg.VOYAGE_API_KEY) {
    throw new Error("VOYAGE_API_KEY not set in .env");
  }
  const body = {
    input,
    model: cfg.EMBED_MODEL,
    input_type: inputType,
    output_dimension: cfg.EMBED_DIM,
    truncation: true,
  };

  let attempt = 0;
  while (true) {
    await pacer.wait();
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.VOYAGE_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const json = (await res.json()) as VoyageResponse;
      json.data.sort((a, b) => a.index - b.index);
      return {
        vectors: json.data.map((d) => d.embedding),
        tokens: json.usage?.total_tokens ?? 0,
      };
    }

    const text = await res.text();
    const isRateLimit = res.status === 429;
    const isTransient = res.status >= 500 || isRateLimit;
    if (!isTransient || attempt >= cfg.EMBED_RETRY_MAX) {
      throw new Error(`Voyage ${res.status}: ${text}`);
    }
    const retryAfter = Number(res.headers.get("retry-after")) || 0;
    const backoff =
      retryAfter > 0 ? retryAfter * 1000 : Math.min(60_000, 2000 * 2 ** attempt);
    pacer.delay(backoff);
    console.warn(
      `[embed] ${res.status} retry ${attempt + 1}/${cfg.EMBED_RETRY_MAX} in ${backoff}ms`
    );
    attempt++;
  }
}

export type EmbedUsageRecorder = (u: {
  inputTokens: number;
  outputTokens: number;
  model?: string | null;
}) => void;

export async function embedBatch(
  cfg: Config,
  texts: string[],
  inputType: EmbedInputType,
  onUsage?: EmbedUsageRecorder
): Promise<{ embeddings: number[][]; tokens: number }> {
  const out: number[][] = new Array(texts.length);
  let totalTokens = 0;

  // RPM → spacing in ms; cap minimum at 1ms to avoid div0 if user sets very high
  const spacing = Math.max(1, Math.floor(60_000 / Math.max(1, cfg.EMBED_RPM)));
  const pacer = new Pacer(spacing);
  // Stay safely under TPM cap (margin for token estimate undercount)
  const tokenBudget = Math.floor(cfg.EMBED_TPM * 0.85);

  let i = 0;
  let batchNum = 0;
  const batches = Math.ceil(texts.length / 1); // upper bound, refined as we go
  while (i < texts.length) {
    const batch: string[] = [];
    const indices: number[] = [];
    let batchTokens = 0;
    while (
      i < texts.length &&
      batch.length < HARD_BATCH_CAP &&
      batchTokens + estimateTokens(texts[i]!) <= tokenBudget
    ) {
      batch.push(texts[i]!);
      indices.push(i);
      batchTokens += estimateTokens(texts[i]!);
      i++;
    }
    if (batch.length === 0) {
      batch.push(texts[i]!);
      indices.push(i);
      batchTokens = estimateTokens(texts[i]!);
      i++;
    }
    batchNum++;
    const remaining = texts.length - i;
    process.stdout.write(
      `\r[embed] batch ${batchNum} (${batch.length} chunks, ~${batchTokens} tok), ${remaining} remaining   `
    );
    const { vectors, tokens: actualTokens } = await call(cfg, pacer, batch, inputType);
    for (let j = 0; j < vectors.length; j++) {
      out[indices[j]!] = vectors[j]!;
    }
    const reportedTokens = actualTokens > 0 ? actualTokens : batchTokens;
    totalTokens += reportedTokens;
    if (onUsage) {
      onUsage({
        inputTokens: reportedTokens,
        outputTokens: 0,
        model: cfg.EMBED_MODEL,
      });
    }
  }
  process.stdout.write("\n");

  return { embeddings: out, tokens: totalTokens };
}

export function toFloat32Buffer(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) {
    buf.writeFloatLE(vec[i]!, i * 4);
  }
  return buf;
}
