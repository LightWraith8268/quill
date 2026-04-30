// Phase 23 helpers — inspirations, submissions, share links.

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { DB } from "./db.ts";

// Inspirations ----------------------------------------------------------

export type InspirationKind = "image" | "quote" | "link" | "note";
export type Inspiration = {
  id: number;
  story_id: number;
  kind: InspirationKind;
  url: string | null;
  content: string | null;
  caption: string | null;
  created_at: number;
};

export function listInspirations(db: DB, storyId: number): Inspiration[] {
  return db
    .query<Inspiration, [number]>(
      "SELECT * FROM inspirations WHERE story_id = ? ORDER BY created_at DESC"
    )
    .all(storyId);
}
export function addInspiration(
  db: DB,
  storyId: number,
  m: { kind: InspirationKind; url?: string; content?: string; caption?: string }
): Inspiration {
  return db
    .query<Inspiration, [number, InspirationKind, string | null, string | null, string | null, number]>(
      `INSERT INTO inspirations (story_id, kind, url, content, caption, created_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`
    )
    .get(storyId, m.kind, m.url ?? null, m.content ?? null, m.caption ?? null, Date.now())!;
}
export function deleteInspiration(db: DB, id: number): boolean {
  return db.prepare<unknown, [number]>("DELETE FROM inspirations WHERE id = ?").run(id).changes > 0;
}

// Submissions ----------------------------------------------------------

export type SubmissionStatus = "queued" | "sent" | "partial" | "full" | "rejected" | "offer" | "withdrawn";
export type Submission = {
  id: number;
  story_id: number;
  agent: string;
  agency: string | null;
  sent_at: number | null;
  response_at: number | null;
  status: SubmissionStatus;
  notes: string | null;
  created_at: number;
  updated_at: number;
};

export function listSubmissions(db: DB, storyId: number): Submission[] {
  return db
    .query<Submission, [number]>(
      "SELECT * FROM submissions WHERE story_id = ? ORDER BY COALESCE(sent_at, created_at) DESC"
    )
    .all(storyId);
}
export function createSubmission(
  db: DB,
  storyId: number,
  m: { agent: string; agency?: string; notes?: string }
): Submission {
  const now = Date.now();
  return db
    .query<Submission, [number, string, string | null, string | null, number, number]>(
      `INSERT INTO submissions (story_id, agent, agency, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`
    )
    .get(storyId, m.agent, m.agency ?? null, m.notes ?? null, now, now)!;
}
export function updateSubmission(
  db: DB,
  id: number,
  patch: Partial<Submission>
): Submission | null {
  const existing = db.query<Submission, [number]>("SELECT * FROM submissions WHERE id = ?").get(id);
  if (!existing) return null;
  const next = {
    agent: patch.agent ?? existing.agent,
    agency: patch.agency ?? existing.agency,
    sent_at: patch.sent_at ?? existing.sent_at,
    response_at: patch.response_at ?? existing.response_at,
    status: (patch.status ?? existing.status) as SubmissionStatus,
    notes: patch.notes ?? existing.notes,
  };
  return db
    .query<
      Submission,
      [string, string | null, number | null, number | null, SubmissionStatus, string | null, number, number]
    >(
      `UPDATE submissions SET agent = ?, agency = ?, sent_at = ?, response_at = ?, status = ?, notes = ?, updated_at = ?
       WHERE id = ? RETURNING *`
    )
    .get(next.agent, next.agency, next.sent_at, next.response_at, next.status, next.notes, Date.now(), id) ?? null;
}
export function deleteSubmission(db: DB, id: number): boolean {
  return db.prepare<unknown, [number]>("DELETE FROM submissions WHERE id = ?").run(id).changes > 0;
}

// Share links ----------------------------------------------------------

export type ShareLink = {
  id: number;
  token: string;
  file_path: string;
  label: string | null;
  expires_at: number | null;
  created_at: number;
};

export function createShareLink(
  db: DB,
  filePath: string,
  label?: string,
  expiresAtMs?: number | null
): ShareLink {
  const token = randomBytes(24).toString("base64url");
  return db
    .query<ShareLink, [string, string, string | null, number | null, number]>(
      `INSERT INTO share_links (token, file_path, label, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?) RETURNING *`
    )
    .get(token, filePath, label ?? null, expiresAtMs ?? null, Date.now())!;
}

export function getShareLinkByToken(db: DB, token: string): ShareLink | null {
  return (
    db.query<ShareLink, [string]>("SELECT * FROM share_links WHERE token = ?").get(token) ?? null
  );
}

export function listShareLinks(db: DB): ShareLink[] {
  return db.query<ShareLink, []>("SELECT * FROM share_links ORDER BY created_at DESC").all();
}

export function revokeShareLink(db: DB, id: number): boolean {
  return db.prepare<unknown, [number]>("DELETE FROM share_links WHERE id = ?").run(id).changes > 0;
}

export async function readSharedFile(
  cfg: Config,
  link: ShareLink
): Promise<{ content: string; bytes: number }> {
  const abs = join(cfg.VAULT_PATH, link.file_path);
  const content = await readFile(abs, "utf-8");
  return { content, bytes: Buffer.byteLength(content, "utf-8") };
}
