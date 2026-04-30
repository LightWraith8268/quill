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
