// What-if branching: clone a story (DB row + outline + style settings).
// Manuscript files are NOT copied — branches share files unless the user
// duplicates them manually. Chat history starts fresh per branch.

import type { DB } from "./db.ts";
import { getStory } from "./stories.ts";
import { listOutline, createNode } from "./outline.ts";

export type BranchResult = {
  storyId: number;
  branchOf: number;
  label: string;
};

export function branchStory(
  db: DB,
  parentStoryId: number,
  label: string
): BranchResult {
  const parent = getStory(db, parentStoryId);
  if (!parent) throw new Error(`story ${parentStoryId} not found`);
  const now = Date.now();

  // Insert new story row, marking branch_of
  const inserted = db
    .query<
      {
        id: number;
      },
      [string, string, string, string, string, number, number, number, string]
    >(
      `INSERT INTO stories
         (path, name, series, active_style, active_genres, created_at, updated_at, branch_of_story_id, branch_label)
       VALUES
         (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`
    )
    .get(
      `${parent.path}::branch::${label}`, // synthetic path so unique constraint holds
      `${parent.name} (what-if: ${label})`,
      parent.series ?? "",
      parent.active_style ?? "",
      JSON.stringify(parent.active_genres),
      now,
      now,
      parentStoryId,
      label
    );
  if (!inserted) throw new Error("branch insert failed");
  const newId = inserted.id;

  // Clone outline (preserve hierarchy via id remap)
  const oldNodes = listOutline(db, parentStoryId);
  const oldToNew = new Map<number, number>();
  // Two passes: create roots first (those without parent), then descendants
  const queue = [...oldNodes];
  while (queue.length > 0) {
    let made = 0;
    for (let i = queue.length - 1; i >= 0; i--) {
      const n = queue[i]!;
      if (n.parent_id === null || oldToNew.has(n.parent_id)) {
        const newParent = n.parent_id ? oldToNew.get(n.parent_id) ?? null : null;
        const created = createNode(db, {
          storyId: newId,
          parentId: newParent,
          kind: n.kind,
          title: n.title,
          summary: n.summary ?? undefined,
          targetWords: n.target_words ?? undefined,
          manuscriptPath: n.manuscript_path ?? undefined,
        });
        oldToNew.set(n.id, created.id);
        queue.splice(i, 1);
        made++;
      }
    }
    if (made === 0) break; // orphan parents — bail
  }

  return {
    storyId: newId,
    branchOf: parentStoryId,
    label,
  };
}
