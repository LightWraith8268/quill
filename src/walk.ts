// Recursively walk vault, collect markdown files with mtime + size + sha256.

import { readdir, stat, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";

export type FileMeta = {
  absPath: string;
  relPath: string; // forward-slash, vault-relative
  mtimeMs: number;
  size: number;
  hash: string;
  content: string;
};

const SKIP_DIRS = new Set([".git", ".obsidian", ".trash", "node_modules"]);
const MD_EXT = /\.(md|markdown)$/i;

export async function walkVault(root: string): Promise<FileMeta[]> {
  const out: FileMeta[] = [];
  await walk(root, root, out);
  return out;
}

async function walk(root: string, dir: string, out: FileMeta[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    if (e.name.startsWith(".")) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      await walk(root, abs, out);
      continue;
    }
    if (!e.isFile() || !MD_EXT.test(e.name)) continue;
    const st = await stat(abs);
    const content = await readFile(abs, "utf-8");
    const hash = createHash("sha256").update(content).digest("hex");
    out.push({
      absPath: abs,
      relPath: relative(root, abs).split(sep).join("/"),
      mtimeMs: Math.floor(st.mtimeMs),
      size: st.size,
      hash,
      content,
    });
  }
}
