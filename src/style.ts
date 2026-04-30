// Style profile loader. Lists/reads .md files in <vault>/Styles/.
// Base profiles live directly under Styles/. Genre overlays live in Styles/genres/.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";

const STYLES_DIR = "Styles";
const GENRES_DIR = "genres";
const MAX_GENRES = 2;

export type StyleProfile = {
  name: string;
  path: string;
  bytes: number;
};

async function dirOk(dir: string): Promise<boolean> {
  try {
    const st = await stat(dir);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function listDirMd(dir: string): Promise<StyleProfile[]> {
  if (!(await dirOk(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const out: StyleProfile[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!/\.md$/i.test(e.name)) continue;
    const abs = join(dir, e.name);
    const st = await stat(abs);
    out.push({
      name: e.name.replace(/\.md$/i, ""),
      path: abs,
      bytes: st.size,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listStyles(cfg: Config): Promise<StyleProfile[]> {
  return listDirMd(join(cfg.VAULT_PATH, STYLES_DIR));
}

export async function listGenres(cfg: Config): Promise<StyleProfile[]> {
  return listDirMd(join(cfg.VAULT_PATH, STYLES_DIR, GENRES_DIR));
}

async function readMd(
  dir: string,
  name: string
): Promise<{ name: string; path: string; content: string } | null> {
  if (!(await dirOk(dir))) return null;
  const safe = name.replace(/\.md$/i, "");
  const abs = join(dir, `${safe}.md`);
  try {
    const content = await readFile(abs, "utf-8");
    return { name: safe, path: abs, content };
  } catch {
    return null;
  }
}

export async function getStyle(
  cfg: Config,
  name: string
): Promise<{ name: string; path: string; content: string } | null> {
  return readMd(join(cfg.VAULT_PATH, STYLES_DIR), name);
}

export async function getGenre(
  cfg: Config,
  name: string
): Promise<{ name: string; path: string; content: string } | null> {
  return readMd(join(cfg.VAULT_PATH, STYLES_DIR, GENRES_DIR), name);
}

export type ComposedStyle = {
  base: { name: string; path: string };
  genres: { name: string; path: string }[];
  content: string;
};

export async function composeStyle(
  cfg: Config,
  baseName: string,
  genreNames: string[]
): Promise<ComposedStyle | null> {
  const base = await getStyle(cfg, baseName);
  if (!base) return null;
  const limited = genreNames.slice(0, MAX_GENRES);
  const genres: { name: string; path: string; content: string }[] = [];
  for (const gName of limited) {
    const g = await getGenre(cfg, gName);
    if (!g) return null;
    genres.push(g);
  }
  const sep =
    "\n\n---\n\n# Active genre overlay" +
    (genres.length > 1 ? "s" : "") +
    "\n\nLayer the following genre rules on top of the base style above. Conflict resolution per base intro.\n\n";
  let content = base.content;
  if (genres.length > 0) {
    content += sep + genres.map((g) => `## ${g.name}\n\n${g.content}`).join("\n\n---\n\n");
  }
  return {
    base: { name: base.name, path: base.path },
    genres: genres.map((g) => ({ name: g.name, path: g.path })),
    content,
  };
}
