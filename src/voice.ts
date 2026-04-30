// Voice fingerprint: cosine similarity between a candidate prose snippet and
// a centroid of the user's own prose embeddings (chunks tagged "style").
// Returns a 0-1 score (1 = strong match) plus the top-similar chunks.

import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { embedBatch } from "./embed.ts";

type ChunkRow = {
  chunk_id: number;
  embedding: Buffer;
  path: string;
  heading_path: string | null;
  start_line: number;
  end_line: number;
  content: string;
};

const VOICE_LIMIT = 800; // sample size for centroid

function bufToFloat32(buf: Buffer, dim: number): Float32Array {
  const f = new Float32Array(dim);
  for (let i = 0; i < dim; i++) f[i] = buf.readFloatLE(i * 4);
  return f;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

function norm(a: Float32Array): number {
  return Math.sqrt(dot(a, a));
}

function cosine(a: Float32Array, b: Float32Array): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

function buildCentroid(chunks: ChunkRow[], dim: number): Float32Array | null {
  if (chunks.length === 0) return null;
  const c = new Float32Array(dim);
  for (const r of chunks) {
    const v = bufToFloat32(r.embedding, dim);
    for (let i = 0; i < dim; i++) c[i]! += v[i]!;
  }
  for (let i = 0; i < dim; i++) c[i]! /= chunks.length;
  return c;
}

export type VoiceCheck = {
  score: number; // cosine 0..1
  band: "drift" | "off-voice" | "matching" | "strong-match";
  centroidSampleSize: number;
  topSimilar: {
    path: string;
    headingPath: string | null;
    startLine: number;
    endLine: number;
    similarity: number;
    preview: string;
  }[];
};

export async function checkVoice(
  cfg: Config,
  db: DB,
  text: string,
  opts: { seriesPath?: string; topK?: number } = {}
): Promise<VoiceCheck> {
  // Pull style-tagged chunks (the user's manuscript prose).
  // Optionally narrow to a specific series prefix.
  let sql = `
    SELECT c.id AS chunk_id, v.embedding, f.path, c.heading_path, c.start_line, c.end_line, c.content
    FROM chunks c
    JOIN files f ON f.id = c.file_id
    JOIN vec_chunks v ON v.chunk_id = c.id
    WHERE ',' || c.tags || ',' LIKE '%,style,%'
  `;
  let rows: ChunkRow[];
  if (opts.seriesPath) {
    sql += ` AND f.path LIKE ? ORDER BY RANDOM() LIMIT ?`;
    rows = db
      .query<ChunkRow, [string, number]>(sql)
      .all(`${opts.seriesPath}%`, VOICE_LIMIT);
  } else {
    sql += ` ORDER BY RANDOM() LIMIT ?`;
    rows = db.query<ChunkRow, [number]>(sql).all(VOICE_LIMIT);
  }

  const centroid = buildCentroid(rows, cfg.EMBED_DIM);
  if (!centroid) {
    return {
      score: 0,
      band: "off-voice",
      centroidSampleSize: 0,
      topSimilar: [],
    };
  }

  const { embeddings } = await embedBatch(cfg, [text], "document");
  const candidate = Float32Array.from(embeddings[0]!);

  const score = Math.max(0, cosine(candidate, centroid));

  // Score bands. Voyage cosines on prose-vs-prose typically sit ~0.55-0.85;
  // calibrate empirically. These thresholds are the starting heuristic.
  let band: VoiceCheck["band"];
  if (score >= 0.78) band = "strong-match";
  else if (score >= 0.68) band = "matching";
  else if (score >= 0.55) band = "drift";
  else band = "off-voice";

  // Top similar chunks — show user where their voice closest aligns
  const topK = opts.topK ?? 5;
  const scored = rows
    .map((r) => ({
      row: r,
      sim: cosine(candidate, bufToFloat32(r.embedding, cfg.EMBED_DIM)),
    }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, topK);

  return {
    score,
    band,
    centroidSampleSize: rows.length,
    topSimilar: scored.map(({ row, sim }) => ({
      path: row.path,
      headingPath: row.heading_path,
      startLine: row.start_line,
      endLine: row.end_line,
      similarity: sim,
      preview:
        row.content.length > 240 ? row.content.slice(0, 240) + "…" : row.content,
    })),
  };
}
