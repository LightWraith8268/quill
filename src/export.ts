// Story export: bundles a single story's manuscript files, drafts, messages,
// and composed style into a single JSON document for offline backup or sharing.

import type { DB } from "./db.ts";
import type { Config } from "./config.ts";
import { getStory, type Story } from "./stories.ts";
import { vaultTree, readVaultFile, type TreeNode } from "./vault.ts";
import { listMessages, type Message } from "./messages.ts";
import { listAllDrafts, getDraft } from "./drafts.ts";
import { composeStyle, type ComposedStyle } from "./style.ts";

export type ExportedFile = {
  path: string;
  content: string;
  mtime: number;
};

export type ExportedDraft = {
  path: string;
  note: string | null;
  content: string;
  hash: string;
  createdAt: number;
};

export type ExportedMessage = {
  role: Message["role"];
  agent: string | null;
  content: string;
  contextUsed: unknown | null;
  createdAt: number;
};

export type StoryExportBundle = {
  exportedAt: number;
  quillVersion: string;
  story: Story;
  style: ComposedStyle | null;
  files: ExportedFile[];
  drafts: ExportedDraft[];
  messages: ExportedMessage[];
};

export type StoryExportResult = {
  filename: string;
  payload: string;
};

const QUILL_VERSION = "0.1.0";

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "story";
}

function dateStamp(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function collectStoryFiles(tree: TreeNode, prefix: string, storyPath: string): TreeNode[] {
  const out: TreeNode[] = [];
  const visit = (n: TreeNode): void => {
    if (n.kind === "file") {
      if (
        (n.path === storyPath || n.path.startsWith(prefix)) &&
        /\.(md|markdown)$/i.test(n.path)
      ) {
        out.push(n);
      }
    }
    if (n.children) for (const c of n.children) visit(c);
  };
  visit(tree);
  return out;
}

export async function buildStoryExport(
  cfg: Config,
  db: DB,
  storyId: number
): Promise<StoryExportResult> {
  const story = getStory(db, storyId);
  if (!story) throw new Error(`story ${storyId} not found`);

  const prefix = story.path.endsWith("/") ? story.path : story.path + "/";

  // Files under Books/<series>/<story>/
  const tree = await vaultTree(cfg);
  const fileNodes = collectStoryFiles(tree, prefix, story.path);
  const files: ExportedFile[] = [];
  for (const n of fileNodes) {
    try {
      const f = await readVaultFile(cfg, n.path);
      files.push({ path: f.path, content: f.content, mtime: f.mtime });
    } catch {
      /* skip unreadable */
    }
  }

  // Composed style (only if base set; ignore failures so export remains best-effort)
  let style: ComposedStyle | null = null;
  if (story.active_style) {
    try {
      style = await composeStyle(cfg, story.active_style, story.active_genres);
    } catch {
      style = null;
    }
  }

  // Messages
  const messages: ExportedMessage[] = listMessages(db, story.id, 10_000).map((m) => ({
    role: m.role,
    agent: m.agent,
    content: m.content,
    contextUsed: m.context_used,
    createdAt: m.created_at,
  }));

  // Drafts: filter listAllDrafts by path prefix; reload each with content via getDraft.
  const allDrafts = listAllDrafts(db);
  const matching = allDrafts.filter(
    (d) => d.file_path === story.path || d.file_path.startsWith(prefix)
  );
  const drafts: ExportedDraft[] = [];
  for (const meta of matching) {
    const full = getDraft(db, meta.id);
    if (!full) continue;
    drafts.push({
      path: full.file_path,
      note: full.note,
      content: full.content,
      hash: full.hash,
      createdAt: full.created_at,
    });
  }

  const now = Date.now();
  const bundle: StoryExportBundle = {
    exportedAt: now,
    quillVersion: QUILL_VERSION,
    story,
    style,
    files,
    drafts,
    messages,
  };

  const filename = `${slugify(story.name)}-${dateStamp(now)}.json`;
  const payload = JSON.stringify(bundle, null, 2);
  return { filename, payload };
}
