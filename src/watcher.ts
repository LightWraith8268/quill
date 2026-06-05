// File watcher: auto-reindex individual markdown files when they change.
//
// Uses Node's fs.watch with { recursive: true }. On Windows this is supported
// natively (ReadDirectoryChangesW). On macOS it works (FSEvents). On Linux
// recursive is not supported and you'd need chokidar — but Quill is targeted
// at Windows desktops next to Obsidian, so this is acceptable.
//
// fs.watch quirks we handle:
//  - Editors (incl. Obsidian) emit multiple events per save (rename + change,
//    or several change events in quick succession). We debounce per-path.
//  - Atomic-rename saves arrive as "rename" events; the file may briefly not
//    exist. We re-stat after the debounce window before deciding delete vs.
//    reindex.
//  - Event filename can be null on some platforms; we ignore those.
//  - The watcher emits paths with OS-native separators; we normalize to
//    forward-slash to match walk.ts relPath convention.

import { watch, type FSWatcher } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { reindexPath, deleteFileByPath } from "./reindex.ts";
import { globToRegExp } from "./walk.ts";
import { proposeFromText } from "./knowledge/selfbuild.ts";
import { parseScopePatterns, scopeFromPath } from "./knowledge/scope.ts";

const SKIP_DIRS = [".git", ".obsidian", ".trash", "node_modules"];
const MD_EXT = /\.(md|markdown)$/i;

export type WatcherOptions = {
  onReindex?: (relPath: string) => void;
  debounceMs?: number;
};

export type StopFn = () => void;

export function startWatcher(
  cfg: Config,
  db: DB,
  opts: WatcherOptions = {}
): StopFn {
  const debounceMs = opts.debounceMs ?? 500;
  const root = cfg.VAULT_PATH;
  const excludes = cfg.INDEX_EXCLUDE.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(globToRegExp);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let watcher: FSWatcher;

  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const relPath = String(filename).split(sep).join("/");
      if (!shouldIndex(relPath)) return;
      if (excludes.some((re) => re.test(relPath))) return;

      const existing = timers.get(relPath);
      if (existing) clearTimeout(existing);
      timers.set(
        relPath,
        setTimeout(() => {
          timers.delete(relPath);
          handleChange(cfg, db, relPath, opts).catch((err) => {
            console.error(
              JSON.stringify({
                type: "reindex_error",
                path: relPath,
                error: err instanceof Error ? err.message : String(err),
              })
            );
          });
        }, debounceMs)
      );
    });
  } catch (err) {
    console.error(`[watcher] failed to start: ${(err as Error).message}`);
    throw err;
  }

  watcher.on("error", (err) => {
    console.error(`[watcher] error: ${err.message}`);
  });

  console.log(`[watcher] watching ${root} (debounce ${debounceMs}ms)`);

  return () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    watcher.close();
  };
}

function shouldIndex(relPath: string): boolean {
  if (!MD_EXT.test(relPath)) return false;
  const parts = relPath.split("/");
  for (const p of parts) {
    if (SKIP_DIRS.includes(p)) return false;
    if (p.startsWith(".")) return false;
  }
  return true;
}

async function handleChange(
  cfg: Config,
  db: DB,
  relPath: string,
  opts: WatcherOptions
): Promise<void> {
  const abs = join(cfg.VAULT_PATH, relPath);
  let exists = true;
  try {
    const st = await stat(abs);
    if (!st.isFile()) exists = false;
  } catch {
    exists = false;
  }

  if (!exists) {
    const dropped = deleteFileByPath(db, relPath);
    if (dropped) {
      console.log(
        JSON.stringify({ type: "reindex_delete", path: relPath })
      );
      opts.onReindex?.(relPath);
    }
    return;
  }

  const t0 = Date.now();
  const result = await reindexPath(cfg, db, relPath);
  console.log(
    JSON.stringify({
      type: "reindex",
      path: relPath,
      durationMs: Date.now() - t0,
      chunks: result.chunksWritten,
    })
  );
  opts.onReindex?.(relPath);

  // Self-building canon: scan the changed prose for new/contradicting facts and
  // queue them for review. Gated — one LLM call per save. Only files that map to
  // a series/book scope (i.e. actual manuscript), never bibles-only dirs.
  if (cfg.QUILL_AUTO_CANON && result.chunksWritten > 0) {
    const scope = scopeFromPath(relPath, parseScopePatterns(cfg.SCOPE_PATTERNS));
    if (scope.series || scope.book) {
      try {
        const content = await readFile(abs, "utf-8");
        const proposed = await proposeFromText(cfg, db, {
          series: scope.series,
          book: scope.book,
          sourcePath: relPath,
          content,
        });
        if (proposed.proposed > 0) {
          console.log(
            JSON.stringify({ type: "canon_proposed", path: relPath, ...proposed })
          );
        }
      } catch (err) {
        console.error(
          JSON.stringify({
            type: "canon_propose_error",
            path: relPath,
            error: err instanceof Error ? err.message : String(err),
          })
        );
      }
    }
  }
}
