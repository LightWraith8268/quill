// Per-story chat messages. SQLite-backed.

import type { DB } from "./db.ts";

export type Role = "user" | "assistant" | "system";
export type AgentName = "claude" | "codex" | "gemini" | null;

export type MessageRow = {
  id: number;
  story_id: number;
  role: Role;
  agent: string | null;
  content: string;
  context_used: string | null;
  created_at: number;
};

export type Message = Omit<MessageRow, "context_used"> & {
  context_used: unknown | null;
};

function rowToMsg(r: MessageRow): Message {
  let ctx: unknown = null;
  if (r.context_used) {
    try {
      ctx = JSON.parse(r.context_used);
    } catch {
      ctx = r.context_used;
    }
  }
  return { ...r, context_used: ctx };
}

export function listMessages(db: DB, storyId: number, limit = 200): Message[] {
  return db
    .query<MessageRow, [number, number]>(
      "SELECT * FROM messages WHERE story_id = ? ORDER BY created_at ASC, id ASC LIMIT ?"
    )
    .all(storyId, limit)
    .map(rowToMsg);
}

export function appendMessage(
  db: DB,
  m: {
    storyId: number;
    role: Role;
    agent?: AgentName;
    content: string;
    contextUsed?: unknown;
  }
): Message {
  const inserted = db
    .query<MessageRow, [number, Role, string | null, string, string | null, number]>(
      `INSERT INTO messages (story_id, role, agent, content, context_used, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .get(
      m.storyId,
      m.role,
      m.agent ?? null,
      m.content,
      m.contextUsed === undefined ? null : JSON.stringify(m.contextUsed),
      Date.now()
    );
  if (!inserted) throw new Error("appendMessage failed");
  return rowToMsg(inserted);
}

export function clearMessages(db: DB, storyId: number): number {
  const r = db
    .prepare<unknown, [number]>("DELETE FROM messages WHERE story_id = ?")
    .run(storyId);
  return Number(r.changes ?? 0);
}

export function getMessage(db: DB, id: number): Message | null {
  const row = db
    .query<MessageRow, [number]>("SELECT * FROM messages WHERE id = ?")
    .get(id);
  return row ? rowToMsg(row) : null;
}

export function updateMessageContent(
  db: DB,
  id: number,
  content: string
): Message {
  const row = db
    .query<MessageRow, [string, number]>(
      "UPDATE messages SET content = ? WHERE id = ? RETURNING *"
    )
    .get(content, id);
  if (!row) throw new Error(`updateMessageContent: message ${id} not found`);
  return rowToMsg(row);
}

/**
 * Deletes the message with id = fromId AND every later message in the same
 * story (ordered by created_at ASC, id ASC). Returns count deleted.
 */
export function deleteFromMessage(
  db: DB,
  storyId: number,
  fromId: number
): number {
  const anchor = db
    .query<{ created_at: number }, [number]>(
      "SELECT created_at FROM messages WHERE id = ?"
    )
    .get(fromId);
  if (!anchor) return 0;
  const result = db
    .prepare<unknown, [number, number, number, number]>(
      `DELETE FROM messages
       WHERE story_id = ?
         AND (created_at > ? OR (created_at = ? AND id >= ?))`
    )
    .run(storyId, anchor.created_at, anchor.created_at, fromId);
  return Number(result.changes ?? 0);
}

/**
 * Deletes every message in the same story strictly AFTER afterId
 * (ordered by created_at ASC, id ASC). Does NOT delete afterId itself.
 */
export function truncateAfterMessage(
  db: DB,
  storyId: number,
  afterId: number
): number {
  const anchor = db
    .query<{ created_at: number }, [number]>(
      "SELECT created_at FROM messages WHERE id = ?"
    )
    .get(afterId);
  if (!anchor) return 0;
  const result = db
    .prepare<unknown, [number, number, number, number]>(
      `DELETE FROM messages
       WHERE story_id = ?
         AND (created_at > ? OR (created_at = ? AND id > ?))`
    )
    .run(storyId, anchor.created_at, anchor.created_at, afterId);
  return Number(result.changes ?? 0);
}
