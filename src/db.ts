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

    CREATE TABLE IF NOT EXISTS outline_nodes (
      id INTEGER PRIMARY KEY,
      story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
      parent_id INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL CHECK(kind IN ('act','chapter','scene','note')),
      title TEXT NOT NULL,
      summary TEXT,
      target_words INTEGER,
      status TEXT NOT NULL DEFAULT 'outlined' CHECK(status IN ('outlined','drafted','revised','locked')),
      manuscript_path TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_outline_story ON outline_nodes(story_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_outline_parent ON outline_nodes(parent_id, sort_order);
  `);

  // Phase 19: branch_of_story_id on stories (added separately for ALTER tolerance)
  try {
    db.exec(`ALTER TABLE stories ADD COLUMN branch_of_story_id INTEGER`);
  } catch {
    /* already exists */
  }
  try {
    db.exec(`ALTER TABLE stories ADD COLUMN branch_label TEXT`);
  } catch {
    /* already exists */
  }

  // Phase 20 — daily goals + time tracker tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY,
      story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('daily_words','total_words','deadline')),
      target INTEGER,
      deadline_ms INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_goals_story ON goals(story_id);

    CREATE TABLE IF NOT EXISTS time_sessions (
      id INTEGER PRIMARY KEY,
      story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      seconds INTEGER NOT NULL DEFAULT 0,
      file_path TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_story ON time_sessions(story_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS inspirations (
      id INTEGER PRIMARY KEY,
      story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('image','quote','link','note')),
      url TEXT,
      content TEXT,
      caption TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inspirations_story ON inspirations(story_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY,
      story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
      agent TEXT NOT NULL,
      agency TEXT,
      sent_at INTEGER,
      response_at INTEGER,
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sent','partial','full','rejected','offer','withdrawn')),
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_submissions_story ON submissions(story_id, sent_at DESC);

    CREATE TABLE IF NOT EXISTS share_links (
      id INTEGER PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      file_path TEXT NOT NULL,
      label TEXT,
      expires_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_share_token ON share_links(token);

    CREATE TABLE IF NOT EXISTS daily_word_log (
      id INTEGER PRIMARY KEY,
      story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      words_at_start INTEGER NOT NULL,
      words_at_end INTEGER NOT NULL,
      delta INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(story_id, day)
    );
  `);

  // Phase 21 — knowledge layer (writerbrain port): typed entity graph, canon
  // facts with weight + scope + temporal applicability, typed relationships,
  // immutable fact history, named snapshots, and appearance tracking. Series/
  // book scoped throughout so retrieval can isolate per series and per book.
  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_entities (
      id INTEGER PRIMARY KEY,
      stable_id TEXT NOT NULL UNIQUE,        -- e.g. C1, L3 (prefix by kind)
      series TEXT,                            -- series scope (NULL = global)
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      canonical_name TEXT,                    -- normalized for matching
      tags TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kb_entities_series ON kb_entities(series, kind);
    CREATE INDEX IF NOT EXISTS idx_kb_entities_name ON kb_entities(canonical_name);

    CREATE TABLE IF NOT EXISTS kb_aliases (
      id INTEGER PRIMARY KEY,
      entity_id INTEGER NOT NULL REFERENCES kb_entities(id) ON DELETE CASCADE,
      alias TEXT NOT NULL,
      UNIQUE(entity_id, alias)
    );
    CREATE INDEX IF NOT EXISTS idx_kb_aliases_alias ON kb_aliases(alias);

    CREATE TABLE IF NOT EXISTS kb_facts (
      id INTEGER PRIMARY KEY,
      entity_id INTEGER REFERENCES kb_entities(id) ON DELETE CASCADE,  -- nullable (world facts)
      series TEXT,
      book TEXT,
      scope TEXT NOT NULL DEFAULT 'series'
        CHECK(scope IN ('global','series','book','chapter','scene')),
      kind TEXT NOT NULL DEFAULT 'fact'
        CHECK(kind IN ('fact','decision','timeline','summary','memory')),
      canon_weight TEXT NOT NULL DEFAULT 'soft_canon'
        CHECK(canon_weight IN ('hard_canon','soft_canon','outline_plan','draft_text','note','rejected')),
      claim TEXT NOT NULL,
      status TEXT,                            -- decisions: proposed/accepted/rejected/superseded
      applies_from_book TEXT,
      applies_from_chapter INTEGER,
      applies_to_book TEXT,
      applies_to_chapter INTEGER,
      source_path TEXT,                       -- vault-relative source
      source_ref TEXT,                        -- heading / line ref
      actor TEXT,                             -- manual/auto-import/llm-extract/reviewer
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kb_facts_entity ON kb_facts(entity_id);
    CREATE INDEX IF NOT EXISTS idx_kb_facts_scope ON kb_facts(series, book, scope);
    CREATE INDEX IF NOT EXISTS idx_kb_facts_weight ON kb_facts(canon_weight);

    CREATE TABLE IF NOT EXISTS kb_edges (
      id INTEGER PRIMARY KEY,
      src_entity_id INTEGER NOT NULL REFERENCES kb_entities(id) ON DELETE CASCADE,
      dst_entity_id INTEGER NOT NULL REFERENCES kb_entities(id) ON DELETE CASCADE,
      rel_type TEXT NOT NULL,
      directed INTEGER NOT NULL DEFAULT 1,    -- 1=directed, 0=bidirectional
      description TEXT,
      weight REAL NOT NULL DEFAULT 1.0,
      series TEXT,
      auto INTEGER NOT NULL DEFAULT 0,        -- 1 = auto-linked from fact text
      source_path TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(src_entity_id, dst_entity_id, rel_type)
    );
    CREATE INDEX IF NOT EXISTS idx_kb_edges_src ON kb_edges(src_entity_id);
    CREATE INDEX IF NOT EXISTS idx_kb_edges_dst ON kb_edges(dst_entity_id);

    CREATE TABLE IF NOT EXISTS kb_fact_history (
      id INTEGER PRIMARY KEY,
      fact_id INTEGER NOT NULL,               -- not FK: history outlives the fact
      entity_id INTEGER,
      change_type TEXT NOT NULL
        CHECK(change_type IN ('create','update','delete','promote','demote')),
      prev_claim TEXT,
      new_claim TEXT,
      prev_weight TEXT,
      new_weight TEXT,
      actor TEXT,
      snapshot_id INTEGER,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kb_fact_history_fact ON kb_fact_history(fact_id, at);

    CREATE TABLE IF NOT EXISTS kb_snapshots (
      id INTEGER PRIMARY KEY,
      series TEXT,
      name TEXT NOT NULL,
      note TEXT,
      state TEXT NOT NULL,                     -- JSON: frozen entities + facts
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kb_snapshots_series ON kb_snapshots(series, created_at DESC);

    CREATE TABLE IF NOT EXISTS kb_appearances (
      id INTEGER PRIMARY KEY,
      entity_id INTEGER NOT NULL REFERENCES kb_entities(id) ON DELETE CASCADE,
      series TEXT,
      book TEXT,
      chapter TEXT,
      file_path TEXT NOT NULL,
      chunk_id INTEGER,
      occurrences INTEGER NOT NULL DEFAULT 1,
      first_seen INTEGER NOT NULL DEFAULT 0,  -- 1 = first appearance in scope
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kb_appearances_entity ON kb_appearances(entity_id, series, book);
    CREATE INDEX IF NOT EXISTS idx_kb_appearances_file ON kb_appearances(file_path);
  `);

  // Self-building canon: proposed facts extracted from prose on save, held in a
  // review queue (NOT in kb_facts) until accepted, so drafts don't pollute
  // canon. Classified new vs contradicts (with the conflicting fact linked).
  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_pending_facts (
      id INTEGER PRIMARY KEY,
      series TEXT,
      book TEXT,
      entity_name TEXT NOT NULL,
      entity_kind TEXT NOT NULL DEFAULT 'character',
      claim TEXT NOT NULL,
      canon_weight TEXT NOT NULL DEFAULT 'draft_text',
      scope TEXT NOT NULL DEFAULT 'book',
      classification TEXT NOT NULL DEFAULT 'new'   -- new | contradicts
        CHECK(classification IN ('new','contradicts')),
      conflict_fact_id INTEGER,                    -- existing fact it contradicts
      conflict_claim TEXT,
      source_path TEXT,
      source_ref TEXT,
      status TEXT NOT NULL DEFAULT 'pending'       -- pending | accepted | rejected
        CHECK(status IN ('pending','accepted','rejected')),
      created_at INTEGER NOT NULL,
      decided_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_kb_pending_status ON kb_pending_facts(series, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_kb_pending_claim ON kb_pending_facts(LOWER(claim));
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

  // Phase 21 — scope columns on chunks so retrieval can isolate per series/book.
  // Populated by the indexer (derived from the Books/<series>/<book>/… path).
  const chunkCols = db
    .query<{ name: string }, []>("SELECT name FROM pragma_table_info('chunks')")
    .all()
    .map((r) => r.name);
  for (const col of ["series", "book"] as const) {
    if (!chunkCols.includes(col)) {
      try {
        db.exec(`ALTER TABLE chunks ADD COLUMN ${col} TEXT`);
      } catch {
        /* race: column may have been added by another connection */
      }
    }
  }
}
