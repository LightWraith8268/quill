// Series-wide rename. Walks all .md files under Books/<series>/, finds matches
// (case-sensitive whole-word by default), returns occurrences for confirmation.
// Apply mode rewrites files + auto-snapshots originals into drafts table.

import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { createDraft } from "./drafts.ts";

export type RenameMatch = {
  path: string;
  line: number;
  col: number;
  context: string;
};

export type RenameReport = {
  series: string;
  needle: string;
  replacement: string;
  matches: RenameMatch[];
  fileCount: number;
};

const fwd = (p: string): string => p.split(sep).join("/");

async function walkSeries(
  cfg: Config,
  series: string
): Promise<{ rel: string; abs: string }[]> {
  const root = join(cfg.VAULT_PATH, "Books", series);
  const out: { rel: string; abs: string }[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) {
        out.push({ abs, rel: fwd(relative(cfg.VAULT_PATH, abs)) });
      }
    }
  }
  if (!(await isDir(root))) return [];
  await walk(root);
  return out;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function findOccurrences(
  text: string,
  needle: string,
  wholeWord: boolean
): { line: number; col: number; context: string }[] {
  const out: { line: number; col: number; context: string }[] = [];
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(wholeWord ? `\\b${escaped}\\b` : escaped, "g");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(line)) !== null) {
      const start = Math.max(0, m.index - 30);
      const end = Math.min(line.length, m.index + needle.length + 30);
      out.push({
        line: i + 1,
        col: m.index + 1,
        context:
          (start > 0 ? "…" : "") +
          line.slice(start, end) +
          (end < line.length ? "…" : ""),
      });
    }
  }
  return out;
}

export async function previewRename(
  cfg: Config,
  series: string,
  needle: string,
  replacement: string,
  wholeWord = true
): Promise<RenameReport> {
  const files = await walkSeries(cfg, series);
  const matches: RenameMatch[] = [];
  for (const f of files) {
    try {
      const text = await readFile(f.abs, "utf-8");
      const hits = findOccurrences(text, needle, wholeWord);
      for (const h of hits) {
        matches.push({ path: f.rel, line: h.line, col: h.col, context: h.context });
      }
    } catch {
      /* skip */
    }
  }
  return {
    series,
    needle,
    replacement,
    matches,
    fileCount: files.length,
  };
}

export async function applyRename(
  cfg: Config,
  db: DB,
  series: string,
  needle: string,
  replacement: string,
  wholeWord = true
): Promise<{ filesTouched: number; totalReplacements: number }> {
  const files = await walkSeries(cfg, series);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(wholeWord ? `\\b${escaped}\\b` : escaped, "g");
  let filesTouched = 0;
  let totalReplacements = 0;
  for (const f of files) {
    let text;
    try {
      text = await readFile(f.abs, "utf-8");
    } catch {
      continue;
    }
    const matches = text.match(re);
    if (!matches) continue;
    // Snapshot before write
    createDraft(db, {
      filePath: f.rel,
      content: text,
      note: `auto: pre-rename ${needle} → ${replacement}`,
    });
    const replaced = text.replace(re, replacement);
    await writeFile(f.abs, replaced, "utf-8");
    filesTouched++;
    totalReplacements += matches.length;
  }
  return { filesTouched, totalReplacements };
}
