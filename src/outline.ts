// Story outline tree: acts → chapters → scenes. Backed by outline_nodes.
// Each node has sort_order within its parent for ordering.

import type { DB } from "./db.ts";

export type NodeKind = "act" | "chapter" | "scene" | "note";
export type NodeStatus = "outlined" | "drafted" | "revised" | "locked";

export type OutlineNode = {
  id: number;
  story_id: number;
  parent_id: number | null;
  sort_order: number;
  kind: NodeKind;
  title: string;
  summary: string | null;
  target_words: number | null;
  status: NodeStatus;
  manuscript_path: string | null;
  created_at: number;
  updated_at: number;
};

export function listOutline(db: DB, storyId: number): OutlineNode[] {
  return db
    .query<OutlineNode, [number]>(
      "SELECT * FROM outline_nodes WHERE story_id = ? ORDER BY COALESCE(parent_id, 0), sort_order, id"
    )
    .all(storyId);
}

export function createNode(
  db: DB,
  m: {
    storyId: number;
    parentId: number | null;
    kind: NodeKind;
    title: string;
    summary?: string;
    targetWords?: number;
    manuscriptPath?: string;
  }
): OutlineNode {
  const maxRow = db
    .query<{ m: number | null }, [number, number | null]>(
      "SELECT MAX(sort_order) AS m FROM outline_nodes WHERE story_id = ? AND COALESCE(parent_id, -1) = COALESCE(?, -1)"
    )
    .get(m.storyId, m.parentId);
  const nextOrder = (maxRow?.m ?? -1) + 1;
  const now = Date.now();
  const inserted = db
    .query<
      OutlineNode,
      [number, number | null, number, NodeKind, string, string | null, number | null, string | null, number, number]
    >(
      `INSERT INTO outline_nodes
       (story_id, parent_id, sort_order, kind, title, summary, target_words, manuscript_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .get(
      m.storyId,
      m.parentId ?? null,
      nextOrder,
      m.kind,
      m.title,
      m.summary ?? null,
      m.targetWords ?? null,
      m.manuscriptPath ?? null,
      now,
      now
    );
  if (!inserted) throw new Error("createNode failed");
  return inserted;
}

export function updateNode(
  db: DB,
  id: number,
  patch: Partial<{
    title: string;
    summary: string | null;
    target_words: number | null;
    status: NodeStatus;
    manuscript_path: string | null;
    parent_id: number | null;
    sort_order: number;
  }>
): OutlineNode | null {
  const existing = db
    .query<OutlineNode, [number]>("SELECT * FROM outline_nodes WHERE id = ?")
    .get(id);
  if (!existing) return null;
  const next = {
    title: patch.title ?? existing.title,
    summary: patch.summary === undefined ? existing.summary : patch.summary,
    target_words:
      patch.target_words === undefined ? existing.target_words : patch.target_words,
    status: patch.status ?? existing.status,
    manuscript_path:
      patch.manuscript_path === undefined
        ? existing.manuscript_path
        : patch.manuscript_path,
    parent_id: patch.parent_id === undefined ? existing.parent_id : patch.parent_id,
    sort_order: patch.sort_order ?? existing.sort_order,
  };
  const updated = db
    .query<
      OutlineNode,
      [string, string | null, number | null, NodeStatus, string | null, number | null, number, number, number]
    >(
      `UPDATE outline_nodes
       SET title = ?, summary = ?, target_words = ?, status = ?, manuscript_path = ?,
           parent_id = ?, sort_order = ?, updated_at = ?
       WHERE id = ? RETURNING *`
    )
    .get(
      next.title,
      next.summary,
      next.target_words,
      next.status,
      next.manuscript_path,
      next.parent_id,
      next.sort_order,
      Date.now(),
      id
    );
  return updated ?? null;
}

export function deleteNode(db: DB, id: number): boolean {
  // Cascade: detach children to root level (set parent_id null) so we don't
  // recursively delete by mistake. Caller can chain deletes if they want.
  db.prepare<unknown, [number]>(
    "UPDATE outline_nodes SET parent_id = NULL WHERE parent_id = ?"
  ).run(id);
  const r = db
    .prepare<unknown, [number]>("DELETE FROM outline_nodes WHERE id = ?")
    .run(id);
  return r.changes > 0;
}

export function reorderNodes(
  db: DB,
  storyId: number,
  parentId: number | null,
  orderedIds: number[]
): void {
  const tx = db.transaction(() => {
    let i = 0;
    for (const id of orderedIds) {
      db.prepare<unknown, [number, number | null, number, number, number]>(
        "UPDATE outline_nodes SET sort_order = ?, parent_id = ?, updated_at = ? WHERE id = ? AND story_id = ?"
      ).run(i, parentId, Date.now(), id, storyId);
      i++;
    }
  });
  tx();
}
