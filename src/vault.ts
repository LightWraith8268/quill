// Read-only vault helpers: directory tree, file read with frontmatter + content,
// entity scan (wikilinks + tags + frontmatter title/aliases).

import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { join, relative, sep, dirname, basename } from "node:path";
import type { Config } from "./config.ts";

const SKIP_DIRS = new Set([".git", ".obsidian", ".trash", "node_modules"]);

export type TreeNode = {
  name: string;
  path: string; // vault-relative, forward slashes
  kind: "dir" | "file";
  size?: number;
  mtime?: number;
  children?: TreeNode[];
};

const fwd = (p: string): string => p.split(sep).join("/");

export async function vaultTree(cfg: Config): Promise<TreeNode> {
  const abs = cfg.VAULT_PATH;
  const root: TreeNode = { name: "vault", path: "", kind: "dir", children: [] };
  await walkInto(root, abs, abs);
  return root;
}

async function walkInto(parent: TreeNode, root: string, dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    if (e.name.startsWith(".")) continue;
    const abs = join(dir, e.name);
    const rel = fwd(relative(root, abs));
    if (e.isDirectory()) {
      const node: TreeNode = { name: e.name, path: rel, kind: "dir", children: [] };
      parent.children!.push(node);
      await walkInto(node, root, abs);
    } else if (e.isFile()) {
      // Only surface readable text files; primarily .md for our use case
      if (!/\.(md|markdown|txt|json|yaml|yml|toml)$/i.test(e.name)) continue;
      const st = await stat(abs);
      parent.children!.push({
        name: e.name,
        path: rel,
        kind: "file",
        size: st.size,
        mtime: Math.floor(st.mtimeMs),
      });
    }
  }
}

function sanitizeRel(rel: string): string {
  // Disallow .. traversal and absolute paths
  const norm = rel.replace(/\\/g, "/");
  if (norm.startsWith("/") || norm.includes("..")) {
    throw new Error("invalid path");
  }
  return norm;
}

export async function readVaultFile(
  cfg: Config,
  rel: string
): Promise<{ path: string; bytes: number; mtime: number; content: string; frontmatter: Record<string, unknown> | null }> {
  const safe = sanitizeRel(rel);
  const abs = join(cfg.VAULT_PATH, safe);
  const st = await stat(abs);
  if (!st.isFile()) throw new Error("not a file");
  const content = await readFile(abs, "utf-8");
  const frontmatter = parseFrontmatter(content);
  return {
    path: safe,
    bytes: st.size,
    mtime: Math.floor(st.mtimeMs),
    content,
    frontmatter,
  };
}

function parseFrontmatter(src: string): Record<string, unknown> | null {
  if (!src.startsWith("---\n") && !src.startsWith("---\r\n")) return null;
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return null;
  const body = m[1] ?? "";
  // Minimal YAML-ish parser: key: value | key: [a, b] | nested keys not supported
  const out: Record<string, unknown> = {};
  let currentKey: string | null = null;
  for (const lineRaw of body.split(/\r?\n/)) {
    const line = lineRaw;
    if (!line.trim()) continue;
    const listMatch = line.match(/^\s*-\s+(.*)$/);
    if (listMatch && currentKey) {
      const arr = (out[currentKey] as unknown[] | undefined) ?? [];
      if (!Array.isArray(arr)) continue;
      arr.push(listMatch[1]!.trim().replace(/^['"]|['"]$/g, ""));
      out[currentKey] = arr;
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_\-]+)\s*:\s*(.*)$/);
    if (kv) {
      const k = kv[1]!;
      const vRaw = kv[2]!.trim();
      if (vRaw === "" || vRaw === "[]") {
        out[k] = vRaw === "[]" ? [] : [];
        currentKey = k;
        continue;
      }
      if (vRaw.startsWith("[") && vRaw.endsWith("]")) {
        out[k] = vRaw
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean);
      } else {
        out[k] = vRaw.replace(/^['"]|['"]$/g, "");
      }
      currentKey = k;
    }
  }
  return out;
}

// ===== Entity / lore scanner =====

export type Entity = {
  name: string;
  occurrences: number;
  files: { path: string; count: number }[]; // backlinks
};

const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

export async function scanEntities(cfg: Config): Promise<Entity[]> {
  const counts = new Map<string, Map<string, number>>(); // entity → (file → count)
  const root = cfg.VAULT_PATH;
  await walkText(root, root, async (rel, content) => {
    let match: RegExpExecArray | null;
    WIKILINK_RE.lastIndex = 0;
    while ((match = WIKILINK_RE.exec(content)) !== null) {
      const target = match[1]!.trim();
      if (!target) continue;
      let perFile = counts.get(target);
      if (!perFile) {
        perFile = new Map();
        counts.set(target, perFile);
      }
      perFile.set(rel, (perFile.get(rel) ?? 0) + 1);
    }
  });

  const entities: Entity[] = [];
  for (const [name, perFile] of counts) {
    const files = [...perFile.entries()].map(([p, c]) => ({ path: p, count: c }));
    files.sort((a, b) => b.count - a.count);
    const occ = files.reduce((s, f) => s + f.count, 0);
    entities.push({ name, occurrences: occ, files });
  }
  entities.sort((a, b) => b.occurrences - a.occurrences || a.name.localeCompare(b.name));
  return entities;
}

async function walkText(
  root: string,
  dir: string,
  fn: (rel: string, content: string) => Promise<void>
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    if (e.name.startsWith(".")) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      await walkText(root, abs, fn);
      continue;
    }
    if (!e.isFile()) continue;
    if (!/\.(md|markdown)$/i.test(e.name)) continue;
    try {
      const content = await readFile(abs, "utf-8");
      await fn(fwd(relative(root, abs)), content);
    } catch {
      /* skip unreadable */
    }
  }
}

// Lookup wiki target → real file path. Tries:
// - exact filename match (with .md), case-insensitive
// - basename match anywhere
export async function resolveWikiTarget(
  cfg: Config,
  target: string
): Promise<string | null> {
  const tree = await vaultTree(cfg);
  const want = target.toLowerCase();
  const wantMd = (target + ".md").toLowerCase();
  let best: string | null = null;
  const visit = (n: TreeNode) => {
    if (n.kind === "file") {
      const base = basename(n.path).toLowerCase();
      if (base === wantMd) {
        best = n.path;
        return;
      }
      if (!best && base.replace(/\.(md|markdown)$/i, "") === want) {
        best = n.path;
      }
    }
    if (n.children) for (const c of n.children) visit(c);
  };
  visit(tree);
  return best;
}

export { dirname };

// ===== Write support =====
// Whitelist top-level dirs that may receive writes from the API.
// Never `Styles/**` or vault-root config files.
const WRITABLE_PREFIXES = ["Books/", "Story Ideas/", "Uncensored/"];

export async function writeVaultFile(
  cfg: Config,
  rel: string,
  content: string
): Promise<{ bytes: number; mtime: number }> {
  const safe = sanitizeRel(rel);
  if (!WRITABLE_PREFIXES.some((p) => safe.startsWith(p))) {
    throw new Error(
      "writes restricted to Books/**, Story Ideas/**, Uncensored/**"
    );
  }
  if (!/\.(md|markdown|txt)$/i.test(safe)) {
    throw new Error("write target must be a .md/.markdown/.txt file");
  }
  const abs = join(cfg.VAULT_PATH, safe);
  // Ensure path stays inside vault after join (defense-in-depth)
  const normVault = cfg.VAULT_PATH.replace(/\\/g, "/").replace(/\/$/, "");
  const normAbs = abs.replace(/\\/g, "/");
  if (!normAbs.startsWith(normVault + "/")) {
    throw new Error("path escapes vault");
  }
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf-8");
  const st = await stat(abs);
  return { bytes: st.size, mtime: Math.floor(st.mtimeMs) };
}
