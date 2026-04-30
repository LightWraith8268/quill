// Reindex vault: walk → diff against files table → for changed files,
// re-chunk → embed → upsert. Removes rows for deleted files.

import { stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { walkVault, type FileMeta } from "./walk.ts";
import { chunkMarkdown } from "./chunker.ts";
import { tagsFor } from "./tags.ts";
import { embedBatch, toFloat32Buffer } from "./embed.ts";

type FileRow = { id: number; path: string; hash: string; mtime_ms: number };

export type ReindexOptions = {
  full: boolean;
};

export type ReindexResult = {
  filesScanned: number;
  filesChanged: number;
  filesDeleted: number;
  chunksWritten: number;
  tokensEmbedded: number;
};

export type ReindexFileResult = {
  filesChanged: number;
  chunksWritten: number;
  tokensEmbedded: number;
};

export async function reindex(
  cfg: Config,
  db: DB,
  opts: ReindexOptions
): Promise<ReindexResult> {
  const t0 = Date.now();
  console.log(`[reindex] walking ${cfg.VAULT_PATH}`);
  const fsFiles = await walkVault(cfg.VAULT_PATH);
  console.log(`[reindex] found ${fsFiles.length} markdown files`);

  const dbFiles = new Map<string, FileRow>();
  for (const row of db
    .query<FileRow, []>("SELECT id, path, hash, mtime_ms FROM files")
    .all()) {
    dbFiles.set(row.path, row);
  }

  const fsByPath = new Map(fsFiles.map((f) => [f.relPath, f]));
  const toIndex: FileMeta[] = [];
  const toDelete: number[] = [];

  for (const f of fsFiles) {
    const existing = dbFiles.get(f.relPath);
    if (opts.full) {
      toIndex.push(f);
      continue;
    }
    if (!existing || existing.hash !== f.hash) {
      toIndex.push(f);
    }
  }
  for (const [path, row] of dbFiles) {
    if (!fsByPath.has(path)) toDelete.push(row.id);
  }

  console.log(
    `[reindex] changed=${toIndex.length} deleted=${toDelete.length} unchanged=${fsFiles.length - toIndex.length}`
  );

  for (const id of toDelete) deleteFileChunksById(db, id);

  let totalChunks = 0;
  let totalTokens = 0;
  for (const f of toIndex) {
    const r = await reindexFile(cfg, db, f.relPath, f);
    totalChunks += r.chunksWritten;
    totalTokens += r.tokensEmbedded;
  }

  console.log(`[reindex] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return {
    filesScanned: fsFiles.length,
    filesChanged: toIndex.length,
    filesDeleted: toDelete.length,
    chunksWritten: totalChunks,
    tokensEmbedded: totalTokens,
  };
}

/**
 * Reindex a single file: drops existing rows, re-chunks, embeds, inserts.
 * Caller supplies the FileMeta (already statted/hashed/read).
 */
export async function reindexFile(
  cfg: Config,
  db: DB,
  relPath: string,
  fileMeta: FileMeta
): Promise<ReindexFileResult> {
  // Drop any existing rows for this path
  const existing = db
    .query<{ id: number }, [string]>("SELECT id FROM files WHERE path = ?")
    .get(relPath);
  if (existing) deleteFileChunksById(db, existing.id);

  const fileTags = tagsFor(relPath, cfg).join(",");
  const upsertFile = db.prepare<
    { id: number },
    [string, number, number, string, number]
  >(
    `INSERT INTO files (path, mtime_ms, size, hash, indexed_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       mtime_ms = excluded.mtime_ms,
       size = excluded.size,
       hash = excluded.hash,
       indexed_at = excluded.indexed_at
     RETURNING id`
  );
  const fileRow = upsertFile.get(
    relPath,
    fileMeta.mtimeMs,
    fileMeta.size,
    fileMeta.hash,
    Date.now()
  );
  if (!fileRow) throw new Error(`upsert failed for ${relPath}`);
  const fileId = fileRow.id;

  const chunks = chunkMarkdown(fileMeta.content, {
    chunkTokens: cfg.CHUNK_TOKENS,
    overlap: cfg.CHUNK_OVERLAP,
  });

  if (chunks.length === 0) {
    return { filesChanged: 1, chunksWritten: 0, tokensEmbedded: 0 };
  }

  const texts = chunks.map((c) => c.content);
  const { embeddings, tokens } = await embedBatch(cfg, texts, "document");

  const insertChunk = db.prepare<
    { id: number },
    [number, number, string, number, number, number, string, string]
  >(
    `INSERT INTO chunks (file_id, ord, heading_path, start_line, end_line, token_count, tags, content)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`
  );
  const insertVec = db.prepare<unknown, [number, Buffer]>(
    `INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)`
  );

  const tx = db.transaction(() => {
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      const row = insertChunk.get(
        fileId,
        c.ord,
        c.headingPath || (null as unknown as string),
        c.startLine,
        c.endLine,
        c.tokenCount,
        fileTags,
        c.content
      );
      if (!row) throw new Error("chunk insert failed");
      insertVec.run(row.id, toFloat32Buffer(embeddings[i]!));
    }
  });
  tx();

  return {
    filesChanged: 1,
    chunksWritten: chunks.length,
    tokensEmbedded: tokens,
  };
}

/**
 * Convenience: stat + read + hash a single file by relPath, then reindex it.
 * Used by the file watcher.
 */
export async function reindexPath(
  cfg: Config,
  db: DB,
  relPath: string
): Promise<ReindexFileResult> {
  const absPath = join(cfg.VAULT_PATH, relPath);
  const st = await stat(absPath);
  const content = await readFile(absPath, "utf-8");
  const hash = createHash("sha256").update(content).digest("hex");
  const meta: FileMeta = {
    absPath,
    relPath,
    mtimeMs: Math.floor(st.mtimeMs),
    size: st.size,
    hash,
    content,
  };
  return reindexFile(cfg, db, relPath, meta);
}

/**
 * Drop all rows (vec, chunks, files) for the file at relPath. No-op if missing.
 */
export function deleteFileByPath(db: DB, relPath: string): boolean {
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM files WHERE path = ?")
    .get(relPath);
  if (!row) return false;
  deleteFileChunksById(db, row.id);
  return true;
}

function deleteFileChunksById(db: DB, fileId: number): void {
  const ids = db
    .query<{ id: number }, [number]>("SELECT id FROM chunks WHERE file_id = ?")
    .all(fileId);
  const delVec = db.prepare<unknown, [number]>(
    "DELETE FROM vec_chunks WHERE chunk_id = ?"
  );
  for (const { id } of ids) delVec.run(id);
  db.prepare<unknown, [number]>("DELETE FROM files WHERE id = ?").run(fileId);
}
