// Reindex vault: walk → diff against files table → for changed files,
// re-chunk → embed → upsert. Removes rows for deleted files.

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

  // Decide what to (re)index
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

  // Drop deleted files (cascades to chunks; vec rows must be cleaned manually)
  for (const id of toDelete) deleteFileChunks(db, id);

  // For changed files, drop old chunks first
  for (const f of toIndex) {
    const existing = dbFiles.get(f.relPath);
    if (existing) deleteFileChunks(db, existing.id);
  }

  // Chunk all
  type Pending = {
    fileMeta: FileMeta;
    fileId: number;
    chunkText: string;
    headingPath: string;
    ord: number;
    startLine: number;
    endLine: number;
    tokenCount: number;
    tags: string;
  };
  const pending: Pending[] = [];

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

  const now = Date.now();
  for (const f of toIndex) {
    const fileTags = tagsFor(f.relPath, cfg).join(",");
    const fileRow = upsertFile.get(
      f.relPath,
      f.mtimeMs,
      f.size,
      f.hash,
      now
    );
    if (!fileRow) throw new Error(`upsert failed for ${f.relPath}`);
    const fileId = fileRow.id;
    const chunks = chunkMarkdown(f.content, {
      chunkTokens: cfg.CHUNK_TOKENS,
      overlap: cfg.CHUNK_OVERLAP,
    });
    for (const c of chunks) {
      pending.push({
        fileMeta: f,
        fileId,
        chunkText: c.content,
        headingPath: c.headingPath,
        ord: c.ord,
        startLine: c.startLine,
        endLine: c.endLine,
        tokenCount: c.tokenCount,
        tags: fileTags,
      });
    }
  }

  console.log(`[reindex] ${pending.length} chunks to embed`);
  if (pending.length === 0) {
    return {
      filesScanned: fsFiles.length,
      filesChanged: toIndex.length,
      filesDeleted: toDelete.length,
      chunksWritten: 0,
      tokensEmbedded: 0,
    };
  }

  const texts = pending.map((p) => p.chunkText);
  const t1 = Date.now();
  const { embeddings, tokens } = await embedBatch(cfg, texts, "document");
  console.log(
    `[reindex] embedded ${pending.length} chunks (~${tokens} tokens) in ${((Date.now() - t1) / 1000).toFixed(1)}s`
  );

  // Insert chunks + vec rows in a single transaction
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
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i]!;
      const row = insertChunk.get(
        p.fileId,
        p.ord,
        p.headingPath || null as unknown as string,
        p.startLine,
        p.endLine,
        p.tokenCount,
        p.tags,
        p.chunkText
      );
      if (!row) throw new Error("chunk insert failed");
      insertVec.run(row.id, toFloat32Buffer(embeddings[i]!));
    }
  });
  tx();

  console.log(`[reindex] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return {
    filesScanned: fsFiles.length,
    filesChanged: toIndex.length,
    filesDeleted: toDelete.length,
    chunksWritten: pending.length,
    tokensEmbedded: tokens,
  };
}

function deleteFileChunks(db: DB, fileId: number): void {
  const ids = db
    .query<{ id: number }, [number]>("SELECT id FROM chunks WHERE file_id = ?")
    .all(fileId);
  const delVec = db.prepare<unknown, [number]>(
    "DELETE FROM vec_chunks WHERE chunk_id = ?"
  );
  for (const { id } of ids) delVec.run(id);
  db.prepare<unknown, [number]>("DELETE FROM files WHERE id = ?").run(fileId);
}
