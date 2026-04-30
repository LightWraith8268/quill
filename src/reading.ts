// Reading-pass mode. Concatenate manuscript files in story order into a
// single rendered stream. Order resolves: outline (manuscript_path of
// 'chapter'/'scene' nodes in tree order) ELSE alphabetic .md files under
// the story path.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { getStory } from "./stories.ts";
import { listOutline } from "./outline.ts";
import { vaultTree, type TreeNode } from "./vault.ts";

export type ReadingPart = {
  title: string;
  path: string;
  content: string;
  bytes: number;
  source: "outline" | "filesystem";
};

function flattenTree(
  node: TreeNode,
  prefix: string,
  out: { name: string; path: string }[]
): void {
  if (node.kind === "file" && node.path.startsWith(prefix) && /\.(md|markdown)$/i.test(node.name)) {
    out.push({ name: node.name, path: node.path });
  }
  if (node.children) for (const c of node.children) flattenTree(c, prefix, out);
}

export async function buildReadingPass(
  cfg: Config,
  db: DB,
  storyId: number
): Promise<{ story: { id: number; name: string; path: string }; parts: ReadingPart[]; totalBytes: number }> {
  const story = getStory(db, storyId);
  if (!story) throw new Error(`story ${storyId} not found`);

  const nodes = listOutline(db, storyId);
  const linked = nodes
    .filter((n) => n.manuscript_path && (n.kind === "chapter" || n.kind === "scene"))
    .sort((a, b) => {
      // depth-first sort by sort_order through ancestors
      const apath = ancestorPath(nodes, a);
      const bpath = ancestorPath(nodes, b);
      for (let i = 0; i < Math.min(apath.length, bpath.length); i++) {
        const ap = apath[i]!;
        const bp = bpath[i]!;
        if (ap !== bp) return ap - bp;
      }
      return apath.length - bpath.length;
    });

  const parts: ReadingPart[] = [];
  if (linked.length > 0) {
    for (const n of linked) {
      if (!n.manuscript_path) continue;
      try {
        const content = await readFile(join(cfg.VAULT_PATH, n.manuscript_path), "utf-8");
        parts.push({
          title: n.title,
          path: n.manuscript_path,
          content,
          bytes: Buffer.byteLength(content, "utf-8"),
          source: "outline",
        });
      } catch {
        /* skip missing file */
      }
    }
  } else {
    // Fallback: alphabetic .md files under the story path
    const tree = await vaultTree(cfg);
    const found: { name: string; path: string }[] = [];
    flattenTree(tree, story.path + "/", found);
    found.sort((a, b) => a.path.localeCompare(b.path));
    for (const f of found) {
      try {
        const content = await readFile(join(cfg.VAULT_PATH, f.path), "utf-8");
        parts.push({
          title: f.name.replace(/\.(md|markdown)$/i, ""),
          path: f.path,
          content,
          bytes: Buffer.byteLength(content, "utf-8"),
          source: "filesystem",
        });
      } catch {
        /* skip */
      }
    }
  }
  return {
    story: { id: story.id, name: story.name, path: story.path },
    parts,
    totalBytes: parts.reduce((s, p) => s + p.bytes, 0),
  };
}

function ancestorPath(
  nodes: { id: number; parent_id: number | null; sort_order: number }[],
  start: { id: number; parent_id: number | null; sort_order: number }
): number[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const path: number[] = [];
  let cur: typeof start | undefined = start;
  while (cur) {
    path.unshift(cur.sort_order);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return path;
}
