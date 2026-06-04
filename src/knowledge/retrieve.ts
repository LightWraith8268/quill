// Canon-aware retrieval: ranked canon facts (by query relevance, then canon
// weight) + series/book-scoped manuscript chunks, merged facts-first. This is
// what buildContext consumes so the model grounds on locked canon, not drafts.

import type { Config } from "../config.ts";
import type { DB } from "../db.ts";
import { search, type SearchScope } from "../search.ts";
import type { EmbedUsageRecorder } from "../embed.ts";
import type { RerankUsageRecorder } from "../rerank.ts";
import { CANON_RANK, KIND_BONUS, type CanonWeight } from "./models.ts";

export type CanonItemKind =
  | "fact"
  | "decision"
  | "timeline"
  | "summary"
  | "memory"
  | "chunk";

export type CanonItem = {
  kind: CanonItemKind;
  entity: string | null;
  canonWeight: CanonWeight | null;
  title: string;
  text: string;
  sourcePath: string | null;
  sourceRef: string | null;
  score: number;
};

export type RetrieveOptions = {
  scope?: SearchScope;
  factK?: number;
  chunkK?: number; // 0 = facts only (skips embedding/vector search)
  useRerank?: boolean;
  onEmbedUsage?: EmbedUsageRecorder;
  onRerankUsage?: RerankUsageRecorder;
};

type FactRow = {
  id: number;
  entity_id: number | null;
  kind: string;
  canon_weight: string;
  claim: string;
  source_path: string | null;
  source_ref: string | null;
  ename: string | null;
};

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

export async function retrieveCanon(
  cfg: Config,
  db: DB,
  query: string,
  opts: RetrieveOptions = {}
): Promise<CanonItem[]> {
  const series = opts.scope?.series ?? null;
  const book = opts.scope?.book ?? null;
  const factK = opts.factK ?? 8;
  const chunkK = opts.chunkK ?? 6;

  // --- Canon facts: scoped, non-rejected; book narrows but keeps series-shared.
  const rows = db
    .query<FactRow, [string | null, string | null, string | null, string | null]>(
      `SELECT f.id, f.entity_id, f.kind, f.canon_weight, f.claim,
              f.source_path, f.source_ref, e.name AS ename
       FROM kb_facts f
       LEFT JOIN kb_entities e ON e.id = f.entity_id
       WHERE (f.series IS ? OR f.series = ?) AND f.canon_weight != 'rejected'
         AND (f.book IS NULL OR ? IS NULL OR f.book = ?)`
    )
    .all(series, series, book, book);

  const qtok = new Set(tokenize(query));
  const rank = (w: string): number => CANON_RANK[w as CanonWeight] ?? 5;
  const overlapOf = (r: FactRow): number => {
    let n = 0;
    for (const t of tokenize((r.ename ?? "") + " " + r.claim)) if (qtok.has(t)) n++;
    return n;
  };

  const scored = rows.map((r) => ({ r, o: overlapOf(r) }));
  // Query-relevant facts first (overlap desc, then canon weight); then fill the
  // remaining slots with the most authoritative canon for grounding.
  const relevant = scored
    .filter((x) => x.o > 0)
    .sort((a, b) => b.o - a.o || rank(a.r.canon_weight) - rank(b.r.canon_weight));
  const grounding = scored
    .filter((x) => x.o === 0)
    .sort((a, b) => rank(a.r.canon_weight) - rank(b.r.canon_weight));

  const facts: CanonItem[] = [];
  const seen = new Set<number>();
  for (const x of [...relevant, ...grounding]) {
    if (facts.length >= factK) break;
    if (seen.has(x.r.id)) continue;
    seen.add(x.r.id);
    facts.push({
      kind: (x.r.kind as CanonItemKind) || "fact",
      entity: x.r.ename,
      canonWeight: x.r.canon_weight as CanonWeight,
      title: x.r.ename ?? "(canon)",
      text: x.r.claim,
      sourcePath: x.r.source_path,
      sourceRef: x.r.source_ref,
      score:
        x.o * 3 +
        (10 - rank(x.r.canon_weight)) * 0.5 +
        (KIND_BONUS[x.r.kind] ?? 0) * 0.1,
    });
  }

  if (chunkK <= 0) return facts;

  // --- Scoped manuscript chunks (vector + BM25, isolated to the series/book).
  const hits = await search(cfg, db, query, {
    mode: "lore",
    topK: chunkK,
    candidates: Math.max(chunkK * 4, 24),
    useRerank: opts.useRerank ?? true,
    scope: opts.scope,
    onEmbedUsage: opts.onEmbedUsage,
    onRerankUsage: opts.onRerankUsage,
  });
  const chunkItems: CanonItem[] = hits.map((h) => ({
    kind: "chunk",
    entity: null,
    canonWeight: null,
    title: h.headingPath ?? h.filePath,
    text: h.content,
    sourcePath: h.filePath,
    sourceRef: h.headingPath,
    score: h.rerankScore ?? h.rrfScore ?? 1 - h.vectorDistance,
  }));

  return [...facts, ...chunkItems];
}
