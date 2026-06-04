// Workspace = any folder under the writing root, opened as a chat context.
// Opening a folder auto-registers it as a story (reusing all chat/history/canon
// machinery), derives its series/book scope from the path, and resolves the cwd
// the agent runs in so that folder's layered CLAUDE.md loads.

import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { upsertStory, type Story } from "./stories.ts";
import { scopeFromPath, type Scope } from "./knowledge/scope.ts";

export function writingRoot(cfg: Config): string {
  return cfg.WRITING_ROOT || cfg.VAULT_PATH;
}

// Normalize + guard a writing-root-relative folder path.
export function safeRelFolder(relPath: string): string {
  const norm = relPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (norm.split("/").some((p) => p === "..")) throw new Error("path escapes root");
  return norm;
}

// The cwd a story's chat runs in: its own folder if it exists, else the vault.
export function storyCwd(cfg: Config, story: { path: string }): string {
  const abs = join(cfg.VAULT_PATH, story.path);
  return existsSync(abs) ? abs : cfg.VAULT_PATH;
}

export type Workspace = { story: Story; scope: Scope; cwd: string };

export function openWorkspace(cfg: Config, db: DB, relPath: string): Workspace {
  const rel = safeRelFolder(relPath);
  const scope = scopeFromPath(rel);
  const name = basename(rel) || "(root)";
  const story = upsertStory(db, { path: rel, name, series: scope.series });
  const abs = join(cfg.VAULT_PATH, rel);
  const cwd = existsSync(abs) ? abs : cfg.VAULT_PATH;
  return { story, scope, cwd };
}
