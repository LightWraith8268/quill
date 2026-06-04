// Hybrid retrieval over chunks: vector (sqlite-vec) + BM25 (FTS5),
// fused via Reciprocal Rank Fusion, optional Voyage rerank.
// Mode filters: lore, style, uncensored, any.

import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { embedBatch, toFloat32Buffer, type EmbedUsageRecorder } from "./embed.ts";
import { rerank, type RerankUsageRecorder } from "./rerank.ts";

export type SearchMode = "lore" | "style" | "uncensored" | "any";

export type SearchHit = {
  chunkId: number;
  filePath: string;
  headingPath: string | null;
  startLine: number;
  endLine: number;
  tags: string;
  content: string;
  vectorDistance: number;
  rerankScore?: number;
  bm25Score?: number;
  rrfScore?: number;
};

export type SearchScope = { series?: string | null; book?: string | null };

export type SearchOptions = {
  mode: SearchMode;
  topK: number;
  candidates: number; // pool size before rerank
  useRerank: boolean;
  scope?: SearchScope; // restrict to a series (+ optionally a book)
  onEmbedUsage?: EmbedUsageRecorder;
  onRerankUsage?: RerankUsageRecorder;
};

type VectorRow = {
  chunk_id: number;
  distance: number;
  path: string;
  heading_path: string | null;
  start_line: number;
  end_line: number;
  tags: string;
  content: string;
};

type Bm25Row = {
  chunk_id: number;
  bm25: number;
  path: string;
  heading_path: string | null;
  start_line: number;
  end_line: number;
  tags: string;
  content: string;
};

const RRF_K = 60;
const FTS5_RESERVED = new Set(["AND", "OR", "NOT", "NEAR"]);

function tagFilter(mode: SearchMode, alias: string): string {
  if (mode === "any") return "";
  return ` AND ',' || ${alias}.tags || ',' LIKE '%,${mode},%'`;
}

// Restrict to a series (+ optional book). Series-scoped chunks plus unscoped
// (NULL) global content are included; a book narrows to that book + series-
// shared (book IS NULL), so sibling books in the series don't bleed in.
function scopeFilter(
  scope: SearchScope | undefined,
  alias: string
): { sql: string; params: string[] } {
  if (!scope?.series) return { sql: "", params: [] };
  const params: string[] = [scope.series];
  let sql = ` AND (${alias}.series = ? OR ${alias}.series IS NULL)`;
  if (scope.book) {
    sql += ` AND (${alias}.book = ? OR ${alias}.book IS NULL)`;
    params.push(scope.book);
  }
  return { sql, params };
}

// Sanitize a free-text user query for FTS5 MATCH. Strips punctuation,
// drops short tokens and reserved words, double-quotes each remaining
// token (escaping embedded quotes), then joins with space (implicit AND).
export function sanitizeFtsQuery(query: string): string {
  const tokens = query
    .split(/[^A-Za-z0-9_]+/)
    .filter((t) => t.length >= 2)
    .filter((t) => !FTS5_RESERVED.has(t.toUpperCase()));
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

export async function search(
  cfg: Config,
  db: DB,
  query: string,
  opts: SearchOptions
): Promise<SearchHit[]> {
  const { embeddings } = await embedBatch(cfg, [query], "query", opts.onEmbedUsage);
  const qvec = embeddings[0]!;
  const qbuf = toFloat32Buffer(qvec);

  const k = Math.max(opts.candidates, opts.topK);
  const scope = scopeFilter(opts.scope, "c");

  // ---- Vector candidates ----
  const vecSql = `
    WITH matches AS (
      SELECT chunk_id, distance
      FROM vec_chunks
      WHERE embedding MATCH ? AND k = ?
      ORDER BY distance
    )
    SELECT
      m.chunk_id AS chunk_id,
      m.distance AS distance,
      f.path AS path,
      c.heading_path AS heading_path,
      c.start_line AS start_line,
      c.end_line AS end_line,
      c.tags AS tags,
      c.content AS content
    FROM matches m
    JOIN chunks c ON c.id = m.chunk_id
    JOIN files f ON f.id = c.file_id
    WHERE 1=1${tagFilter(opts.mode, "c")}${scope.sql}
    ORDER BY m.distance
    LIMIT ?
  `;
  const vecRows = db
    .query<VectorRow, (Buffer | number | string)[]>(vecSql)
    .all(qbuf, k, ...scope.params, k);

  // ---- BM25 candidates (optional) ----
  let bm25Rows: Bm25Row[] = [];
  const ftsQuery = cfg.HYBRID_BM25 ? sanitizeFtsQuery(query) : "";
  if (cfg.HYBRID_BM25 && ftsQuery.length > 0) {
    const bm25Sql = `
      SELECT
        c.id AS chunk_id,
        bm25(chunks_fts) AS bm25,
        f.path AS path,
        c.heading_path AS heading_path,
        c.start_line AS start_line,
        c.end_line AS end_line,
        c.tags AS tags,
        c.content AS content
      FROM chunks_fts
      JOIN chunks c ON c.id = chunks_fts.rowid
      JOIN files f ON f.id = c.file_id
      WHERE chunks_fts MATCH ?${tagFilter(opts.mode, "c")}${scope.sql}
      ORDER BY bm25(chunks_fts) ASC
      LIMIT ?
    `;
    try {
      bm25Rows = db
        .query<Bm25Row, (string | number)[]>(bm25Sql)
        .all(ftsQuery, ...scope.params, k);
    } catch {
      // FTS5 parse error or table missing — degrade silently to vector-only.
      bm25Rows = [];
    }
  }

  // ---- Build per-chunk hits + RRF fusion ----
  const byId = new Map<number, SearchHit>();
  const rrf = new Map<number, number>();

  vecRows.forEach((r, idx) => {
    const rank = idx + 1;
    const score = 1 / (RRF_K + rank);
    rrf.set(r.chunk_id, (rrf.get(r.chunk_id) ?? 0) + score);
    byId.set(r.chunk_id, {
      chunkId: r.chunk_id,
      filePath: r.path,
      headingPath: r.heading_path,
      startLine: r.start_line,
      endLine: r.end_line,
      tags: r.tags,
      content: r.content,
      vectorDistance: r.distance,
    });
  });

  bm25Rows.forEach((r, idx) => {
    const rank = idx + 1;
    const score = 1 / (RRF_K + rank);
    rrf.set(r.chunk_id, (rrf.get(r.chunk_id) ?? 0) + score);
    const existing = byId.get(r.chunk_id);
    if (existing) {
      existing.bm25Score = r.bm25;
    } else {
      byId.set(r.chunk_id, {
        chunkId: r.chunk_id,
        filePath: r.path,
        headingPath: r.heading_path,
        startLine: r.start_line,
        endLine: r.end_line,
        tags: r.tags,
        content: r.content,
        vectorDistance: Infinity,
        bm25Score: r.bm25,
      });
    }
  });

  // Edge cases: if one list is empty, the other still drives ordering via RRF.
  // (Both empty → return []. Single populated list → ranking == that list's order.)
  let hits: SearchHit[] = Array.from(byId.values()).map((h) => ({
    ...h,
    rrfScore: rrf.get(h.chunkId) ?? 0,
  }));

  hits.sort((a, b) => (b.rrfScore ?? 0) - (a.rrfScore ?? 0));
  hits = hits.slice(0, opts.candidates);

  if (opts.useRerank && hits.length > 0) {
    const docs = hits.map((h) => h.content);
    const ranked = await rerank(cfg, query, docs, opts.topK, opts.onRerankUsage);
    hits = ranked.map((r) => ({
      ...hits[r.index]!,
      rerankScore: r.score,
    }));
  } else {
    hits = hits.slice(0, opts.topK);
  }

  return hits;
}
