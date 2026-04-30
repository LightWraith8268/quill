// Daily-writing dashboard: goals (daily target / total / deadline),
// time-tracking sessions, daily word delta log. Pure persistence helpers
// + a snapshot/aggregation endpoint.

import type { DB } from "./db.ts";

export type GoalKind = "daily_words" | "total_words" | "deadline";

export type Goal = {
  id: number;
  story_id: number;
  kind: GoalKind;
  target: number | null;
  deadline_ms: number | null;
  created_at: number;
  updated_at: number;
};

export type TimeSession = {
  id: number;
  story_id: number;
  started_at: number;
  ended_at: number | null;
  seconds: number;
  file_path: string | null;
};

export type DailyWordRow = {
  id: number;
  story_id: number;
  day: string;
  words_at_start: number;
  words_at_end: number;
  delta: number;
  updated_at: number;
};

export function listGoals(db: DB, storyId: number): Goal[] {
  return db.query<Goal, [number]>("SELECT * FROM goals WHERE story_id = ?").all(storyId);
}

export function upsertGoal(
  db: DB,
  storyId: number,
  kind: GoalKind,
  target: number | null,
  deadlineMs: number | null
): Goal {
  const now = Date.now();
  const existing = db
    .query<Goal, [number, GoalKind]>(
      "SELECT * FROM goals WHERE story_id = ? AND kind = ?"
    )
    .get(storyId, kind);
  if (existing) {
    return db
      .query<Goal, [number | null, number | null, number, number]>(
        `UPDATE goals SET target = ?, deadline_ms = ?, updated_at = ? WHERE id = ? RETURNING *`
      )
      .get(target, deadlineMs, now, existing.id)!;
  }
  return db
    .query<Goal, [number, GoalKind, number | null, number | null, number, number]>(
      `INSERT INTO goals (story_id, kind, target, deadline_ms, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`
    )
    .get(storyId, kind, target, deadlineMs, now, now)!;
}

export function deleteGoal(db: DB, id: number): boolean {
  return (
    db.prepare<unknown, [number]>("DELETE FROM goals WHERE id = ?").run(id).changes > 0
  );
}

// Time-tracking
export function startSession(db: DB, storyId: number, filePath?: string): TimeSession {
  const now = Date.now();
  return db
    .query<TimeSession, [number, number, string | null]>(
      `INSERT INTO time_sessions (story_id, started_at, file_path)
       VALUES (?, ?, ?) RETURNING *`
    )
    .get(storyId, now, filePath ?? null)!;
}

export function heartbeat(db: DB, sessionId: number): TimeSession | null {
  const now = Date.now();
  const row = db
    .query<TimeSession, [number]>(
      "SELECT * FROM time_sessions WHERE id = ?"
    )
    .get(sessionId);
  if (!row) return null;
  const seconds = Math.max(row.seconds, Math.floor((now - row.started_at) / 1000));
  return db
    .query<TimeSession, [number, number, number]>(
      `UPDATE time_sessions SET seconds = ?, ended_at = ? WHERE id = ? RETURNING *`
    )
    .get(seconds, now, sessionId)!;
}

export function endSession(db: DB, sessionId: number): TimeSession | null {
  return heartbeat(db, sessionId);
}

export function recentSessions(db: DB, storyId: number, days = 30): TimeSession[] {
  const cutoff = Date.now() - days * 86_400_000;
  return db
    .query<TimeSession, [number, number]>(
      "SELECT * FROM time_sessions WHERE story_id = ? AND started_at >= ? ORDER BY started_at DESC"
    )
    .all(storyId, cutoff);
}

// Daily word delta log
export function logWordsForDay(
  db: DB,
  storyId: number,
  day: string,
  wordsAtEnd: number
): DailyWordRow {
  const now = Date.now();
  const existing = db
    .query<DailyWordRow, [number, string]>(
      "SELECT * FROM daily_word_log WHERE story_id = ? AND day = ?"
    )
    .get(storyId, day);
  if (existing) {
    const delta = wordsAtEnd - existing.words_at_start;
    return db
      .query<DailyWordRow, [number, number, number, number]>(
        "UPDATE daily_word_log SET words_at_end = ?, delta = ?, updated_at = ? WHERE id = ? RETURNING *"
      )
      .get(wordsAtEnd, delta, now, existing.id)!;
  }
  // First entry today: read previous day's end (or 0)
  const prev = db
    .query<DailyWordRow, [number]>(
      "SELECT * FROM daily_word_log WHERE story_id = ? ORDER BY day DESC LIMIT 1"
    )
    .get(storyId);
  const start = prev?.words_at_end ?? wordsAtEnd;
  const delta = wordsAtEnd - start;
  return db
    .query<DailyWordRow, [number, string, number, number, number, number]>(
      `INSERT INTO daily_word_log (story_id, day, words_at_start, words_at_end, delta, updated_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`
    )
    .get(storyId, day, start, wordsAtEnd, delta, now)!;
}

export function dailyLog(db: DB, storyId: number, days = 30): DailyWordRow[] {
  return db
    .query<DailyWordRow, [number, number]>(
      "SELECT * FROM daily_word_log WHERE story_id = ? ORDER BY day DESC LIMIT ?"
    )
    .all(storyId, days);
}
