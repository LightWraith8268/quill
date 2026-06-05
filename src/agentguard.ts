// Safety net for auto-acting chat. Before an agent-capable turn, capture a
// baseline of the story's manuscript files; after the turn, snapshot the
// PRE-edit content of any file the agent changed (reusing the draft system, so
// the existing diff/restore UI makes every edit reversible). New files are
// reported but need no snapshot (delete reverts them).

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { createDraft } from "./drafts.ts";

const MD_EXT = /\.(md|markdown)$/i;
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 200;

export type Baseline = Map<string, string>; // vault-relative path → content

// Read the story folder's manuscript files into memory (bounded). Keys are
// vault-relative so they match drafts.file_path and the editor's paths.
export async function captureBaseline(cfg: Config, story: { path: string }): Promise<Baseline> {
  const out: Baseline = new Map();
  const root = join(cfg.VAULT_PATH, story.path);
  const walk = async (absDir: string, relDir: string): Promise<void> => {
    if (out.size >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.size >= MAX_FILES) return;
      if (e.name.startsWith(".")) continue;
      if (/\.bak/i.test(e.name)) continue;
      const abs = join(absDir, e.name);
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(abs, rel);
      } else if (e.isFile() && MD_EXT.test(e.name)) {
        try {
          const st = await stat(abs);
          if (st.size > MAX_FILE_BYTES) continue;
          out.set(`${story.path}/${rel}`, await readFile(abs, "utf-8"));
        } catch {
          /* skip */
        }
      }
    }
  };
  await walk(root, "");
  return out;
}

export type EditSummary = { changed: string[]; created: string[] };

// After the turn: snapshot the pre-edit content of changed files and report
// changed + newly-created paths. Returns empty when nothing was written.
export async function snapshotChanges(
  db: DB,
  cfg: Config,
  story: { path: string },
  baseline: Baseline
): Promise<EditSummary> {
  const changed: string[] = [];
  for (const [rel, before] of baseline) {
    let after: string | null = null;
    try {
      after = await readFile(join(cfg.VAULT_PATH, rel), "utf-8");
    } catch {
      after = null; // deleted
    }
    if (after === null || after !== before) {
      try {
        createDraft(db, { filePath: rel, content: before, note: "auto: before agent edit" });
      } catch {
        /* non-fatal */
      }
      changed.push(rel);
    }
  }

  // Newly-created manuscript files (present now, absent from baseline).
  const current = await captureBaseline(cfg, story);
  const created: string[] = [];
  for (const rel of current.keys()) {
    if (!baseline.has(rel)) created.push(rel);
  }

  return { changed, created };
}
