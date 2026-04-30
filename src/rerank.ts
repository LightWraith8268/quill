// Voyage AI reranker. POST /v1/rerank.
// API: https://docs.voyageai.com/reference/reranker-api

import type { Config } from "./config.ts";

const ENDPOINT = "https://api.voyageai.com/v1/rerank";

type RerankResponse = {
  data: { index: number; relevance_score: number }[];
  usage: { total_tokens: number };
};

export type RerankUsageRecorder = (u: {
  inputTokens: number;
  outputTokens: number;
  model?: string | null;
}) => void;

export async function rerank(
  cfg: Config,
  query: string,
  documents: string[],
  topK: number,
  onUsage?: RerankUsageRecorder
): Promise<{ index: number; score: number }[]> {
  if (documents.length === 0) return [];
  if (!cfg.VOYAGE_API_KEY) throw new Error("VOYAGE_API_KEY not set");

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      query,
      documents,
      model: cfg.RERANK_MODEL,
      top_k: Math.min(topK, documents.length),
      truncation: true,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Rerank ${res.status}: ${text}`);
  }
  const json = (await res.json()) as RerankResponse;
  if (onUsage) {
    onUsage({
      inputTokens: json.usage?.total_tokens ?? 0,
      outputTokens: 0,
      model: cfg.RERANK_MODEL,
    });
  }
  return json.data.map((d) => ({ index: d.index, score: d.relevance_score }));
}
