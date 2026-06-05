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

// Dependency-free local reranker for the free/local-embeddings path (no Voyage
// key). Scores each candidate by query-term coverage + term frequency + an
// exact-phrase bonus. Not a neural cross-encoder, but a real lift over raw RRF.
function rrTokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
}

export function localRerank(
  query: string,
  documents: string[],
  topK: number
): { index: number; score: number }[] {
  const qSet = new Set(rrTokenize(query));
  const phrase = query.toLowerCase().trim();
  const scored = documents.map((doc, index) => {
    const lower = doc.toLowerCase();
    const counts = new Map<string, number>();
    for (const t of rrTokenize(doc)) counts.set(t, (counts.get(t) ?? 0) + 1);
    let overlap = 0;
    let tf = 0;
    for (const t of qSet) {
      const c = counts.get(t) ?? 0;
      if (c > 0) {
        overlap++;
        tf += Math.log(1 + c);
      }
    }
    const coverage = qSet.size ? overlap / qSet.size : 0;
    const phraseBonus = phrase.length >= 4 && lower.includes(phrase) ? 1.5 : 0;
    return { index, score: coverage * 2 + tf * 0.1 + phraseBonus };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.min(topK, scored.length));
}

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
