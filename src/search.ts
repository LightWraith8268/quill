// Vector search over chunks via sqlite-vec, optional Voyage rerank.
// Mode filters: lore, style, uncensored, any.

import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { embedBatch, toFloat32Buffer } from "./embed.ts";
import { rerank } from "./rerank.ts";

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
};

export type SearchOptions = {
  mode: SearchMode;
  topK: number;
  candidates: number; // vector candidates before rerank
  useRerank: boolean;
};

type ChunkRow = {
  chunk_id: number;
  distance: number;
  path: string;
  heading_path: string | null;
  start_line: number;
  end_line: number;
  tags: string;
  content: string;
};

function tagFilter(mode: SearchMode): string {
  if (mode === "any") return "";
  return ` AND ',' || c.tags || ',' LIKE '%,${mode},%'`;
}

export async function search(
  cfg: Config,
  db: DB,
  query: string,
  opts: SearchOptions
): Promise<SearchHit[]> {
  const { embeddings } = await embedBatch(cfg, [query], "query");
  const qvec = embeddings[0]!;
  const qbuf = toFloat32Buffer(qvec);

  const k = Math.max(opts.candidates, opts.topK);

  // Two-step: pull top-k by vector distance from vec_chunks, then join meta.
  const sql = `
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
    WHERE 1=1${tagFilter(opts.mode)}
    ORDER BY m.distance
    LIMIT ?
  `;
  const rows = db.query<ChunkRow, [Buffer, number, number]>(sql).all(qbuf, k, k);

  let hits: SearchHit[] = rows.map((r) => ({
    chunkId: r.chunk_id,
    filePath: r.path,
    headingPath: r.heading_path,
    startLine: r.start_line,
    endLine: r.end_line,
    tags: r.tags,
    content: r.content,
    vectorDistance: r.distance,
  }));

  if (opts.useRerank && hits.length > 0) {
    const docs = hits.map((h) => h.content);
    const ranked = await rerank(cfg, query, docs, opts.topK);
    hits = ranked.map((r) => ({
      ...hits[r.index]!,
      rerankScore: r.score,
    }));
  } else {
    hits = hits.slice(0, opts.topK);
  }

  return hits;
}
