// Draft snapshots. Stores a copy of file content keyed by vault-relative path
// + sha256 for dedup. Independent of git — meant for writers' "this version
// before the rewrite" use case.

import { createHash } from "node:crypto";
import type { DB } from "./db.ts";

export type DraftRow = {
  id: number;
  file_path: string;
  note: string | null;
  content: string;
  hash: string;
  bytes: number;
  created_at: number;
};
export type Draft = DraftRow;

export function listDraftsForFile(db: DB, filePath: string): Draft[] {
  return db
    .query<DraftRow, [string]>(
      "SELECT id, file_path, note, hash, bytes, created_at, '' as content FROM drafts WHERE file_path = ? ORDER BY created_at DESC"
    )
    .all(filePath);
}

export function listAllDrafts(db: DB): Draft[] {
  return db
    .query<DraftRow, []>(
      "SELECT id, file_path, note, hash, bytes, created_at, '' as content FROM drafts ORDER BY created_at DESC LIMIT 500"
    )
    .all();
}

export function getDraft(db: DB, id: number): Draft | null {
  return (
    db
      .query<DraftRow, [number]>(
        "SELECT id, file_path, note, hash, bytes, created_at, content FROM drafts WHERE id = ?"
      )
      .get(id) ?? null
  );
}

export function createDraft(
  db: DB,
  m: { filePath: string; content: string; note?: string }
): Draft {
  const hash = createHash("sha256").update(m.content).digest("hex");
  // Skip exact-content duplicate of last snapshot for this file
  const last = db
    .query<{ hash: string }, [string]>(
      "SELECT hash FROM drafts WHERE file_path = ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(m.filePath);
  if (last && last.hash === hash) {
    const existing = db
      .query<DraftRow, [string]>(
        "SELECT id, file_path, note, hash, bytes, created_at, content FROM drafts WHERE file_path = ? ORDER BY created_at DESC LIMIT 1"
      )
      .get(m.filePath);
    if (existing) return existing;
  }
  const inserted = db
    .query<DraftRow, [string, string | null, string, string, number, number]>(
      `INSERT INTO drafts (file_path, note, content, hash, bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING id, file_path, note, hash, bytes, created_at, content`
    )
    .get(
      m.filePath,
      m.note ?? null,
      m.content,
      hash,
      Buffer.byteLength(m.content, "utf-8"),
      Date.now()
    );
  if (!inserted) throw new Error("createDraft failed");
  return inserted;
}

// Strip frontmatter, fenced code blocks, headings/list markers, then tokenize.
export function wordCount(text: string): number {
  if (!text) return 0;
  let s = text;
  // Strip leading frontmatter
  if (s.startsWith("---\n") || s.startsWith("---\r\n")) {
    const m = s.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
    if (m) s = s.slice(m[0].length);
  }
  // Strip fenced code blocks
  s = s.replace(/```[\s\S]*?```/g, " ");
  // Strip inline code
  s = s.replace(/`[^`\n]*`/g, " ");
  // Strip header markers and list/blockquote markers at line starts
  s = s.replace(/^[ \t]*(#{1,6}\s+|[-*+]\s+|>\s+|\d+\.\s+)/gm, "");
  const tokens = s.match(/\b\w+\b/g);
  return tokens ? tokens.length : 0;
}

export type WordCountSnapshot = {
  ts: number;
  words: number;
  bytes: number;
  note: string | null;
};

export function countWordsByPathTimeline(
  db: DB,
  filePath: string
): WordCountSnapshot[] {
  const rows = db
    .query<
      { content: string; bytes: number; created_at: number; note: string | null },
      [string]
    >(
      "SELECT content, bytes, created_at, note FROM drafts WHERE file_path = ? ORDER BY created_at ASC"
    )
    .all(filePath);
  return rows.map((r) => ({
    ts: r.created_at,
    words: wordCount(r.content),
    bytes: r.bytes,
    note: r.note,
  }));
}

export function deleteDraft(db: DB, id: number): boolean {
  const r = db.prepare<unknown, [number]>("DELETE FROM drafts WHERE id = ?").run(id);
  return r.changes > 0;
}
