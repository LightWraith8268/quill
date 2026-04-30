// Story discovery + persistence.
// A "story" = a folder under <vault>/Books/<series>/<story>/.
// The story folder is expected to contain manuscript .md files (e.g. Manuscript.md
// or numbered chapter files). The series folder contains shared bibles
// (CHARACTER_BIBLE.md, SYSTEM_RULES_TABLE.md, etc.).

import { readdir, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import type { DB } from "./db.ts";
import type { Config } from "./config.ts";

const BOOKS_DIR = "Books";

export type DiscoveredStory = {
  path: string; // vault-relative, forward slashes
  name: string;
  series: string;
};

export type StoryRow = {
  id: number;
  path: string;
  name: string;
  series: string | null;
  active_style: string | null;
  active_genres: string;
  active_scene_path: string | null;
  created_at: number;
  updated_at: number;
};

export type Story = Omit<StoryRow, "active_genres"> & { active_genres: string[] };

function rowToStory(r: StoryRow): Story {
  let genres: string[] = [];
  try {
    const parsed = JSON.parse(r.active_genres);
    if (Array.isArray(parsed)) genres = parsed.filter((s): s is string => typeof s === "string");
  } catch {
    /* noop */
  }
  return { ...r, active_genres: genres, active_scene_path: r.active_scene_path ?? null };
}

async function isDir(p: string): Promise<boolean> {
  try {
    const st = await stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

export async function discoverStories(cfg: Config): Promise<DiscoveredStory[]> {
  const booksAbs = join(cfg.VAULT_PATH, BOOKS_DIR);
  if (!(await isDir(booksAbs))) return [];

  const out: DiscoveredStory[] = [];
  const seriesEntries = await readdir(booksAbs, { withFileTypes: true });
  for (const s of seriesEntries) {
    if (!s.isDirectory()) continue;
    if (s.name.startsWith(".")) continue;
    const seriesAbs = join(booksAbs, s.name);
    const storyEntries = await readdir(seriesAbs, { withFileTypes: true });
    for (const b of storyEntries) {
      if (!b.isDirectory()) continue;
      if (b.name.startsWith(".")) continue;
      out.push({
        path: `${BOOKS_DIR}/${s.name}/${b.name}`,
        name: b.name,
        series: s.name,
      });
    }
  }
  return out.sort((a, b) =>
    a.series.localeCompare(b.series) || a.name.localeCompare(b.name)
  );
}

export function listStories(db: DB): Story[] {
  return db
    .query<StoryRow, []>(
      "SELECT * FROM stories ORDER BY series ASC, name ASC"
    )
    .all()
    .map(rowToStory);
}

export function getStory(db: DB, id: number): Story | null {
  const row = db
    .query<StoryRow, [number]>("SELECT * FROM stories WHERE id = ?")
    .get(id);
  return row ? rowToStory(row) : null;
}

export function getStoryByPath(db: DB, path: string): Story | null {
  const row = db
    .query<StoryRow, [string]>("SELECT * FROM stories WHERE path = ?")
    .get(path);
  return row ? rowToStory(row) : null;
}

export function upsertStory(
  db: DB,
  s: { path: string; name: string; series: string }
): Story {
  const now = Date.now();
  const existing = getStoryByPath(db, s.path);
  if (existing) return existing;
  const inserted = db
    .query<StoryRow, [string, string, string, number, number]>(
      `INSERT INTO stories (path, name, series, active_genres, created_at, updated_at)
       VALUES (?, ?, ?, '[]', ?, ?)
       RETURNING *`
    )
    .get(s.path, s.name, s.series, now, now);
  if (!inserted) throw new Error("upsertStory failed");
  return rowToStory(inserted);
}

export function updateStory(
  db: DB,
  id: number,
  patch: {
    active_style?: string | null;
    active_genres?: string[];
    active_scene_path?: string | null;
  }
): Story | null {
  const existing = getStory(db, id);
  if (!existing) return null;
  const next = {
    active_style:
      patch.active_style === undefined ? existing.active_style : patch.active_style,
    active_genres:
      patch.active_genres === undefined ? existing.active_genres : patch.active_genres.slice(0, 2),
    active_scene_path:
      patch.active_scene_path === undefined ? existing.active_scene_path : patch.active_scene_path,
  };
  const updated = db
    .query<StoryRow, [string | null, string, string | null, number, number]>(
      `UPDATE stories
       SET active_style = ?, active_genres = ?, active_scene_path = ?, updated_at = ?
       WHERE id = ?
       RETURNING *`
    )
    .get(
      next.active_style,
      JSON.stringify(next.active_genres),
      next.active_scene_path,
      Date.now(),
      id
    );
  return updated ? rowToStory(updated) : null;
}

export function deleteStory(db: DB, id: number): boolean {
  const r = db
    .prepare<unknown, [number]>("DELETE FROM stories WHERE id = ?")
    .run(id);
  return r.changes > 0;
}

// Glob-style match for story-folder content (manuscript chunks under Books/Series/Story/**)
export function storyPathPrefix(s: { path: string }): string {
  return s.path.endsWith("/") ? s.path : s.path + "/";
}

// Useful for normalizing paths returned from the file walker (Windows).
export function toForwardSlash(p: string): string {
  return p.split(sep).join("/");
}
