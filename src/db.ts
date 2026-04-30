import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "./config.ts";

export type DB = Database;

export function openDb(cfg: Config): DB {
  mkdirSync(dirname(cfg.DB_PATH), { recursive: true });
  Database.setCustomSQLite(""); // use Bun bundled
  const db = new Database(cfg.DB_PATH, { create: true });
  sqliteVec.load(db);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA foreign_keys=ON");
  migrate(db, cfg);
  return db;
}

function migrate(db: DB, cfg: Config): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      mtime_ms INTEGER NOT NULL,
      size INTEGER NOT NULL,
      hash TEXT NOT NULL,
      indexed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      ord INTEGER NOT NULL,
      heading_path TEXT,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      token_count INTEGER NOT NULL,
      tags TEXT NOT NULL,           -- comma list: style,lore,uncensored
      content TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_tags ON chunks(tags);

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      content, heading_path, tags,
      content_rowid='id', tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, content, heading_path, tags)
      VALUES (new.id, new.content, COALESCE(new.heading_path,''), new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, heading_path, tags)
      VALUES ('delete', old.id, old.content, COALESCE(old.heading_path,''), old.tags);
    END;

    CREATE TABLE IF NOT EXISTS stories (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,            -- vault-relative, e.g. "Books/Warborn Protocols/2 Network Recruit"
      name TEXT NOT NULL,                   -- display
      series TEXT,                          -- series folder name
      active_style TEXT,                    -- base profile name
      active_genres TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      agent TEXT,
      content TEXT NOT NULL,
      context_used TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_story ON messages(story_id, created_at);

    CREATE TABLE IF NOT EXISTS drafts (
      id INTEGER PRIMARY KEY,
      file_path TEXT NOT NULL,        -- vault-relative
      note TEXT,
      content TEXT NOT NULL,
      hash TEXT NOT NULL,             -- sha256 for dedup
      bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_drafts_path ON drafts(file_path, created_at DESC);

    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      story_id INTEGER,
      agent TEXT NOT NULL,
      model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      meta TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_story ON usage_events(story_id, ts DESC);
  `);

  const existing = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_chunks'"
    )
    .get();
  if (!existing) {
    db.exec(
      `CREATE VIRTUAL TABLE vec_chunks USING vec0(
         chunk_id INTEGER PRIMARY KEY,
         embedding FLOAT[${cfg.EMBED_DIM}]
       )`
    );
  }

  // Idempotent ALTER TABLE: stories.active_scene_path
  const storyCols = db
    .query<{ name: string }, []>("SELECT name FROM pragma_table_info('stories')")
    .all()
    .map((r) => r.name);
  if (!storyCols.includes("active_scene_path")) {
    try {
      db.exec("ALTER TABLE stories ADD COLUMN active_scene_path TEXT");
    } catch {
      /* race: column may have been added by another connection */
    }
  }
}
