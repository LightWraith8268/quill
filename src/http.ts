// HTTP API. Hono + Bun.serve. Localhost-only by default.
// API routes mounted under /api. Web SPA served at /.
// Auth: bearer token via HTTP_TOKEN env. Empty token = unauthenticated allowed
// (dev only). All API routes accept JSON.

import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { z } from "zod";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { openDb } from "./db.ts";
import { reindex } from "./reindex.ts";
import { search, type SearchMode } from "./search.ts";
import { listStyles, getStyle, listGenres, getGenre, composeStyle } from "./style.ts";
import {
  discoverStories,
  listStories,
  getStory,
  upsertStory,
  updateStory,
  deleteStory,
} from "./stories.ts";
import { listMessages, clearMessages } from "./messages.ts";
import { runChat, runChatRegenerate } from "./chat.ts";
import { extractStory } from "./knowledge/extract.ts";
import {
  proposeFromStory,
  listPending,
  pendingCount,
  acceptPending,
  rejectPending,
  clearPending,
} from "./knowledge/selfbuild.ts";
import {
  timelineEvents,
  knowledgeStateAt,
  maxChapter,
  setFactBounds,
} from "./knowledge/timeline.ts";
import { entityCount, factCount, listGraph, entityFacts } from "./knowledge/store.ts";
import { retrieveCanon } from "./knowledge/retrieve.ts";
import { checkContinuity, checkContinuityFile } from "./knowledge/continuity.ts";
import { alignBeats, pacingReport } from "./knowledge/structure.ts";
import { createSnapshot, listSnapshots, diffSnapshots, factHistory } from "./knowledge/history.ts";
import { openWorkspace } from "./workspace.ts";
import type { AgentSelection } from "./agents/router.ts";
import { listWorkflows, getWorkflow } from "./workflows.ts";
import { vaultTree, readVaultFile, scanEntities, resolveWikiTarget, writeVaultFile } from "./vault.ts";
import { parseCharacterBible } from "./character_bible.ts";
import { readdir, readFile, stat } from "node:fs/promises";
import {
  createDraft,
  listAllDrafts,
  listDraftsForFile,
  getDraft,
  deleteDraft,
  countWordsByPathTimeline,
  wordCount,
} from "./drafts.ts";
import { checkHealth } from "./health.ts";
import { logError, recentErrors } from "./errlog.ts";
import { listUsageEvents, usageRollup } from "./usage.ts";
import { checkVoice } from "./voice.ts";
import { runEnsemble } from "./ensemble.ts";
import { inlineEditStream, inlineContinueStream, inlineGhost } from "./inline.ts";
import { editorialPass, isEditorialPass, EDITORIAL_PASSES } from "./editorial.ts";
import {
  listOutline,
  createNode,
  updateNode,
  deleteNode,
  reorderNodes,
  type NodeKind,
  type NodeStatus,
} from "./outline.ts";
import { buildReadingPass } from "./reading.ts";
import { compileStory } from "./compile.ts";
import { clipUrl } from "./research.ts";
import { buildGlossary } from "./glossary.ts";
import { branchStory } from "./branches.ts";
import { buildBeats, loadPronunciationMap, savePronunciationMap } from "./beats.ts";
import { previewRename, applyRename } from "./rename.ts";
import { buildIcsForStory } from "./ics.ts";
import {
  listInspirations,
  addInspiration,
  deleteInspiration,
  listSubmissions,
  createSubmission,
  updateSubmission,
  deleteSubmission,
  createShareLink,
  getShareLinkByToken,
  listShareLinks,
  revokeShareLink,
  readSharedFile,
  type InspirationKind,
  type SubmissionStatus,
} from "./extras.ts";
import {
  listGoals,
  upsertGoal,
  deleteGoal,
  startSession,
  heartbeat,
  endSession,
  recentSessions,
  logWordsForDay,
  dailyLog,
  type GoalKind,
} from "./dashboard.ts";
import { readFile as fsReadFile } from "node:fs/promises";
import { buildStoryExport } from "./export.ts";

const SearchBody = z.object({
  query: z.string().min(1),
  mode: z.enum(["lore", "style", "uncensored", "any"]).default("lore"),
  topK: z.number().int().positive().max(50).default(8),
  candidates: z.number().int().positive().max(200).default(40),
  useRerank: z.boolean().default(true),
});

const ReindexBody = z.object({
  full: z.boolean().default(false),
});

const ComposeBody = z.object({
  base: z.string().min(1),
  genres: z.array(z.string()).max(2).default([]),
});

const StoryUpsertBody = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  series: z.string().min(1),
});

const StoryPatchBody = z.object({
  active_style: z.string().nullable().optional(),
  active_genres: z.array(z.string()).max(2).optional(),
  active_scene_path: z.string().nullable().optional(),
});

const ChatBody = z.object({
  message: z.string().min(1),
  agent: z.enum(["claude", "codex", "gemini", "auto"]).default("auto"),
  mode: z.enum(["chat", "agent"]).default("chat"),
});

const RegenerateBody = z.object({
  fromMessageId: z.number().int().positive(),
  agent: z.enum(["claude", "codex", "gemini", "auto"]).default("auto"),
  editedContent: z.string().optional(),
});

const WorkflowRunBody = z.object({
  workflowId: z.string().min(1),
  inputs: z.record(z.string(), z.string()).default({}),
});

const DraftCreateBody = z.object({
  filePath: z.string().min(1),
  note: z.string().optional(),
});

const VaultWriteBody = z.object({
  path: z.string().min(1),
  content: z.string(),
  snapshotNote: z.string().optional(),
});

const VaultInsertBody = z.object({
  path: z.string().min(1),
  text: z.string().min(1),
  mode: z.enum(["append", "prepend", "at-line"]),
  line: z.number().int().positive().optional(),
  snapshotNote: z.string().optional(),
});

const VoiceCheckBody = z.object({
  text: z.string().min(1),
  seriesPath: z.string().optional(),
});

const EnsembleBody = z.object({
  message: z.string().min(1),
  agents: z.array(z.enum(["claude", "codex", "gemini"])).optional(),
});

const InlineEditBody = z.object({
  storyId: z.number().int().positive().optional(),
  selection: z.string().min(1),
  instruction: z.string().min(1),
});

const InlineContinueBody = z.object({
  storyId: z.number().int().positive().optional(),
  precedingText: z.string().min(1),
  length: z.enum(["sentence", "paragraph", "scene"]).optional(),
});

const InlineGhostBody = z.object({
  storyId: z.number().int().positive().optional(),
  precedingText: z.string().min(1),
  variant: z.number().int().min(0).optional(),
});

const EditorialBody = z.object({
  storyId: z.number().int().positive().optional(),
  text: z.string().min(1),
  pass: z.string().min(1),
});

const OutlineCreateBody = z.object({
  parentId: z.number().int().positive().nullable().optional(),
  kind: z.enum(["act", "chapter", "scene", "note"]),
  title: z.string().min(1),
  summary: z.string().optional(),
  targetWords: z.number().int().nonnegative().optional(),
  manuscriptPath: z.string().optional(),
});

const OutlineUpdateBody = z.object({
  title: z.string().optional(),
  summary: z.string().nullable().optional(),
  target_words: z.number().int().nonnegative().nullable().optional(),
  status: z.enum(["outlined", "drafted", "revised", "locked"]).optional(),
  manuscript_path: z.string().nullable().optional(),
  parent_id: z.number().int().positive().nullable().optional(),
  sort_order: z.number().int().nonnegative().optional(),
});

const OutlineReorderBody = z.object({
  parentId: z.number().int().positive().nullable(),
  orderedIds: z.array(z.number().int().positive()),
});

const ClipBody = z.object({
  url: z.string().url(),
  topic: z.string().optional(),
});

const BranchBody = z.object({
  label: z.string().min(1).max(60),
});

const GoalBody = z.object({
  kind: z.enum(["daily_words", "total_words", "deadline"]),
  target: z.number().int().nonnegative().nullable().optional(),
  deadline_ms: z.number().int().positive().nullable().optional(),
});

const SessionStartBody = z.object({
  filePath: z.string().optional(),
});

const SessionHeartbeatBody = z.object({
  sessionId: z.number().int().positive(),
});

const DayLogBody = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  wordsAtEnd: z.number().int().nonnegative(),
});

const RenameBody = z.object({
  series: z.string().min(1),
  needle: z.string().min(1),
  replacement: z.string(),
  wholeWord: z.boolean().optional(),
  apply: z.boolean().optional(),
});

export function buildApp(cfg: Config) {
  const app = new Hono();
  const db = openDb(cfg);

  const apiAuth = async (
    c: { req: { header: (k: string) => string | undefined; path: string }; json: (b: unknown, s?: number) => Response },
    next: () => Promise<void>
  ): Promise<void | Response> => {
    if (!cfg.HTTP_TOKEN) return next();
    if (c.req.path === "/api/health") return next();
    // Public share-link read endpoint — token in URL, not bearer
    if (c.req.path.startsWith("/api/share/")) return next();
    const auth = c.req.header("Authorization") ?? "";
    const expected = `Bearer ${cfg.HTTP_TOKEN}`;
    if (auth !== expected) return c.json({ error: "unauthorized" }, 401);
    return next();
  };

  app.use("/api/*", apiAuth as Parameters<typeof app.use>[1]);

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/health/full", async (c) => {
    try {
      const report = await checkHealth(cfg);
      return c.json(report);
    } catch (e) {
      logError("http.health.full", e);
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.get("/api/errors", (c) => {
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Math.max(1, Math.min(500, Number(limitRaw) || 100)) : 100;
    return c.json({ errors: recentErrors(limit) });
  });

  app.get("/api/stats", (c) => {
    const files = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM files").get()!.n;
    const chunks = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM chunks").get()!.n;
    const vec = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM vec_chunks").get()!.n;
    return c.json({ files, chunks, vec_rows: vec });
  });

  app.post("/api/search", async (c) => {
    const parsed = SearchBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "bad request", issues: parsed.error.flatten() }, 400);
    }
    const { query, mode, topK, candidates, useRerank } = parsed.data;
    const hits = await search(cfg, db, query, {
      mode: mode as SearchMode,
      topK,
      candidates,
      useRerank,
    });
    return c.json({ hits });
  });

  app.post("/api/reindex", async (c) => {
    const parsed = ReindexBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "bad request", issues: parsed.error.flatten() }, 400);
    }
    const result = await reindex(cfg, db, { full: parsed.data.full });
    return c.json(result);
  });

  app.get("/api/style/list", async (c) => {
    const styles = await listStyles(cfg);
    return c.json({ styles });
  });

  app.get("/api/style/get/:name", async (c) => {
    const name = c.req.param("name");
    const profile = await getStyle(cfg, name);
    if (!profile) return c.json({ error: "not found" }, 404);
    return c.json(profile);
  });

  app.get("/api/genre/list", async (c) => {
    const genres = await listGenres(cfg);
    return c.json({ genres });
  });

  app.get("/api/genre/get/:name", async (c) => {
    const name = c.req.param("name");
    const g = await getGenre(cfg, name);
    if (!g) return c.json({ error: "not found" }, 404);
    return c.json(g);
  });

  app.post("/api/style/compose", async (c) => {
    const parsed = ComposeBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "bad request", issues: parsed.error.flatten() }, 400);
    }
    const composed = await composeStyle(cfg, parsed.data.base, parsed.data.genres);
    if (!composed) return c.json({ error: "base or genre not found" }, 404);
    return c.json(composed);
  });

  // ===== Stories =====

  app.get("/api/stories/discover", async (c) => {
    const discovered = await discoverStories(cfg);
    return c.json({ stories: discovered });
  });

  app.get("/api/stories", (c) => {
    return c.json({ stories: listStories(db) });
  });

  app.post("/api/stories", async (c) => {
    const parsed = StoryUpsertBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "bad request", issues: parsed.error.flatten() }, 400);
    const story = upsertStory(db, parsed.data);
    return c.json(story);
  });

  app.get("/api/stories/:id", (c) => {
    const id = Number(c.req.param("id"));
    const story = getStory(db, id);
    if (!story) return c.json({ error: "not found" }, 404);
    return c.json(story);
  });

  app.patch("/api/stories/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const parsed = StoryPatchBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "bad request", issues: parsed.error.flatten() }, 400);
    const story = updateStory(db, id, parsed.data);
    if (!story) return c.json({ error: "not found" }, 404);
    return c.json(story);
  });

  app.delete("/api/stories/:id", (c) => {
    const id = Number(c.req.param("id"));
    const ok = deleteStory(db, id);
    return c.json({ ok });
  });

  app.get("/api/stories/:id/messages", (c) => {
    const id = Number(c.req.param("id"));
    return c.json({ messages: listMessages(db, id) });
  });

  app.delete("/api/stories/:id/messages", (c) => {
    const id = Number(c.req.param("id"));
    const removed = clearMessages(db, id);
    return c.json({ removed });
  });

  // ===== Vault tree / files =====

  app.get("/api/vault/tree", async (c) => {
    const tree = await vaultTree(cfg);
    return c.json(tree);
  });

  app.get("/api/vault/file", async (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path required" }, 400);
    try {
      const file = await readVaultFile(cfg, path);
      return c.json(file);
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : String(e) },
        404
      );
    }
  });

  app.get("/api/vault/resolve", async (c) => {
    const target = c.req.query("target");
    if (!target) return c.json({ error: "target required" }, 400);
    const path = await resolveWikiTarget(cfg, target);
    return c.json({ target, path });
  });

  app.post("/api/vault/write", async (c) => {
    const parsed = VaultWriteBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "bad request", issues: parsed.error.flatten() }, 400);
    const { path, content, snapshotNote } = parsed.data;
    let snapshotId: number | undefined;
    try {
      const existing = await readVaultFile(cfg, path);
      const d = createDraft(db, {
        filePath: path,
        content: existing.content,
        note: snapshotNote ?? "auto: before insert",
      });
      snapshotId = d.id;
    } catch {
      // file does not exist yet → no snapshot
    }
    try {
      const out = await writeVaultFile(cfg, path, content);
      return c.json({ ok: true, bytes: out.bytes, mtime: out.mtime, snapshotId });
    } catch (e) {
      logError("http.vault.write", e);
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  app.post("/api/vault/insert", async (c) => {
    const parsed = VaultInsertBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "bad request", issues: parsed.error.flatten() }, 400);
    const { path, text, mode, line, snapshotNote } = parsed.data;

    let existingContent = "";
    let fileExists = false;
    try {
      const existing = await readVaultFile(cfg, path);
      existingContent = existing.content;
      fileExists = true;
    } catch {
      fileExists = false;
    }

    let nextContent: string;
    if (mode === "append") {
      const sep = existingContent.length === 0 || existingContent.endsWith("\n") ? "" : "\n";
      const trail = text.endsWith("\n") ? "" : "\n";
      nextContent = existingContent + sep + text + trail;
    } else if (mode === "prepend") {
      nextContent = existingContent.length === 0 ? (text.endsWith("\n") ? text : text + "\n") : text + "\n\n" + existingContent;
    } else {
      // at-line: 1-based; 1 = top, lines.length+1 = end
      const lines = existingContent.length === 0 ? [] : existingContent.split("\n");
      const targetLine = line ?? 1;
      const maxLine = lines.length + 1;
      if (targetLine < 1 || targetLine > maxLine) {
        return c.json({ error: `line ${targetLine} out of bounds (1..${maxLine})` }, 400);
      }
      const insertText = text.endsWith("\n") ? text : text + "\n";
      const insertLines = insertText.split("\n");
      // Drop trailing empty from split if insertText ended with \n
      if (insertLines.length > 0 && insertLines[insertLines.length - 1] === "") insertLines.pop();
      const before = lines.slice(0, targetLine - 1);
      const after = lines.slice(targetLine - 1);
      nextContent = [...before, ...insertLines, ...after].join("\n");
    }

    let snapshotId: number | undefined;
    if (fileExists) {
      const d = createDraft(db, {
        filePath: path,
        content: existingContent,
        note: snapshotNote ?? "auto: before insert",
      });
      snapshotId = d.id;
    }

    try {
      const out = await writeVaultFile(cfg, path, nextContent);
      return c.json({ ok: true, bytes: out.bytes, mtime: out.mtime, snapshotId });
    } catch (e) {
      logError("http.vault.insert", e);
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  // ===== Lore / entities =====

  app.get("/api/lore/entities", async (c) => {
    const entities = await scanEntities(cfg);
    return c.json({ entities });
  });

  // ===== Character Bibles =====

  app.get("/api/characters", async (c) => {
    const booksDir = join(cfg.VAULT_PATH, "Books");
    const out: { series: string; characterCount: number }[] = [];
    try {
      const seriesEntries = await readdir(booksDir, { withFileTypes: true });
      for (const e of seriesEntries) {
        if (!e.isDirectory()) continue;
        const biblePath = join(booksDir, e.name, "CHARACTER_BIBLE.md");
        try {
          const st = await stat(biblePath);
          if (st.isFile()) {
            const content = await readFile(biblePath, "utf-8");
            const characters = parseCharacterBible(content);
            out.push({ series: e.name, characterCount: characters.length });
          }
        } catch {
          /* no bible for this series */
        }
      }
    } catch {
      /* Books dir missing */
    }
    return c.json({ series: out });
  });

  app.get("/api/characters/:series", async (c) => {
    const series = decodeURIComponent(c.req.param("series"));
    const biblePath = join(cfg.VAULT_PATH, "Books", series, "CHARACTER_BIBLE.md");
    try {
      const content = await readFile(biblePath, "utf-8");
      const characters = parseCharacterBible(content);
      return c.json({ series, characters });
    } catch (e) {
      return c.json(
        { error: `CHARACTER_BIBLE.md not found for series ${series}` },
        404
      );
    }
  });

  // ===== Drafts (snapshots) =====

  app.get("/api/drafts", (c) => {
    const path = c.req.query("path");
    return c.json({
      drafts: path ? listDraftsForFile(db, path) : listAllDrafts(db),
    });
  });

  app.post("/api/drafts", async (c) => {
    const parsed = DraftCreateBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "bad request", issues: parsed.error.flatten() }, 400);
    let file;
    try {
      file = await readVaultFile(cfg, parsed.data.filePath);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 404);
    }
    const d = createDraft(db, {
      filePath: parsed.data.filePath,
      content: file.content,
      note: parsed.data.note,
    });
    return c.json({ id: d.id, file_path: d.file_path, note: d.note, hash: d.hash, bytes: d.bytes, created_at: d.created_at });
  });

  app.get("/api/drafts/:id", (c) => {
    const id = Number(c.req.param("id"));
    const d = getDraft(db, id);
    if (!d) return c.json({ error: "not found" }, 404);
    return c.json(d);
  });

  app.delete("/api/drafts/:id", (c) => {
    const id = Number(c.req.param("id"));
    const ok = deleteDraft(db, id);
    return c.json({ ok });
  });

  // ===== Story word counts / pacing =====

  app.get("/api/stories/:id/wordcount", async (c) => {
    const id = Number(c.req.param("id"));
    const story = getStory(db, id);
    if (!story) return c.json({ error: "story not found" }, 404);

    // Collect all .md files under story.path from the vault tree
    const tree = await vaultTree(cfg);
    const prefix = story.path.endsWith("/") ? story.path : story.path + "/";
    const collected: { path: string; mtime: number; bytes: number }[] = [];
    const visit = (n: { kind: string; path: string; size?: number; mtime?: number; children?: unknown[] }) => {
      if (n.kind === "file") {
        if (
          (n.path === story.path || n.path.startsWith(prefix)) &&
          /\.(md|markdown)$/i.test(n.path)
        ) {
          collected.push({
            path: n.path,
            mtime: n.mtime ?? 0,
            bytes: n.size ?? 0,
          });
        }
      }
      if (n.children) {
        for (const child of n.children as typeof n[]) visit(child);
      }
    };
    visit(tree as unknown as Parameters<typeof visit>[0]);

    let totalWords = 0;
    const files = await Promise.all(
      collected.map(async (f) => {
        let currentWords = 0;
        let currentBytes = f.bytes;
        let currentMtime = f.mtime;
        try {
          const file = await readVaultFile(cfg, f.path);
          currentWords = wordCount(file.content);
          currentBytes = file.bytes;
          currentMtime = file.mtime;
        } catch {
          // unreadable — skip word count
        }
        const timeline = countWordsByPathTimeline(db, f.path);
        totalWords += currentWords;
        return {
          path: f.path,
          currentWords,
          currentBytes,
          currentMtime,
          timeline,
        };
      })
    );

    files.sort((a, b) => a.path.localeCompare(b.path));

    return c.json({
      story: { id: story.id, name: story.name, path: story.path },
      files,
      totalWords,
    });
  });

  // ===== Story export =====

  app.get("/api/stories/:id/export", async (c) => {
    const id = Number(c.req.param("id"));
    try {
      const { filename, payload } = await buildStoryExport(cfg, db, id);
      return new Response(payload, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
        },
      });
    } catch (e) {
      logError("http.story.export", e);
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg.includes("not found") ? 404 : 500;
      return c.json({ error: msg }, status);
    }
  });

  // ===== Voice fingerprint =====

  app.post("/api/voice/check", async (c) => {
    const parsed = VoiceCheckBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "bad request", issues: parsed.error.flatten() }, 400);
    }
    try {
      const result = await checkVoice(cfg, db, parsed.data.text, {
        seriesPath: parsed.data.seriesPath,
      });
      return c.json(result);
    } catch (e) {
      logError("http.voice.check", e);
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  // ===== Inline editor AI (Cmd+K rewrite, Tab continue) =====

  const inlineSse = (
    gen: AsyncGenerator<string, void, void>
  ): Response => {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        const send = (event: string, data: unknown): void => {
          controller.enqueue(
            enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        };
        try {
          for await (const chunk of gen) {
            send("delta", { text: chunk });
          }
          send("done", {});
        } catch (e) {
          send("error", { error: e instanceof Error ? e.message : String(e) });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  };

  app.post("/api/edit/inline", async (c) => {
    const parsed = InlineEditBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "bad request", issues: parsed.error.flatten() }, 400);
    return inlineSse(inlineEditStream(cfg, db, parsed.data));
  });

  app.post("/api/edit/continue", async (c) => {
    const parsed = InlineContinueBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "bad request", issues: parsed.error.flatten() }, 400);
    return inlineSse(inlineContinueStream(cfg, db, parsed.data));
  });

  // Ambient ghost completion — short, canon-aware, returned whole (not SSE).
  app.post("/api/edit/ghost", async (c) => {
    const parsed = InlineGhostBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "bad request", issues: parsed.error.flatten() }, 400);
    try {
      const result = await inlineGhost(cfg, db, parsed.data);
      return c.json(result);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  // Editorial passes — list available passes, and run one over text/selection.
  app.get("/api/edit/passes", (c) =>
    c.json({
      passes: Object.entries(EDITORIAL_PASSES).map(([id, p]) => ({
        id,
        label: p.label,
        blurb: p.blurb,
      })),
    })
  );

  app.post("/api/edit/pass", async (c) => {
    const parsed = EditorialBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "bad request", issues: parsed.error.flatten() }, 400);
    if (!isEditorialPass(parsed.data.pass)) {
      return c.json({ error: `unknown pass "${parsed.data.pass}"` }, 400);
    }
    try {
      const result = await editorialPass(cfg, db, {
        storyId: parsed.data.storyId,
        text: parsed.data.text,
        pass: parsed.data.pass,
      });
      return c.json(result);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  // ===== Outline =====

  app.get("/api/stories/:id/outline", (c) => {
    const id = Number(c.req.param("id"));
    return c.json({ nodes: listOutline(db, id) });
  });

  app.post("/api/stories/:id/outline", async (c) => {
    const id = Number(c.req.param("id"));
    const parsed = OutlineCreateBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "bad request", issues: parsed.error.flatten() }, 400);
    const node = createNode(db, {
      storyId: id,
      parentId: parsed.data.parentId ?? null,
      kind: parsed.data.kind as NodeKind,
      title: parsed.data.title,
      summary: parsed.data.summary,
      targetWords: parsed.data.targetWords,
      manuscriptPath: parsed.data.manuscriptPath,
    });
    return c.json(node);
  });

  app.patch("/api/outline/:nodeId", async (c) => {
    const nodeId = Number(c.req.param("nodeId"));
    const parsed = OutlineUpdateBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "bad request", issues: parsed.error.flatten() }, 400);
    const node = updateNode(db, nodeId, {
      ...parsed.data,
      status: parsed.data.status as NodeStatus | undefined,
    });
    if (!node) return c.json({ error: "not found" }, 404);
    return c.json(node);
  });

  app.delete("/api/outline/:nodeId", (c) => {
    const nodeId = Number(c.req.param("nodeId"));
    const ok = deleteNode(db, nodeId);
    return c.json({ ok });
  });

  app.post("/api/stories/:id/outline/reorder", async (c) => {
    const id = Number(c.req.param("id"));
    const parsed = OutlineReorderBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "bad request", issues: parsed.error.flatten() }, 400);
    reorderNodes(db, id, parsed.data.parentId, parsed.data.orderedIds);
    return c.json({ ok: true });
  });

  // ===== Reading-pass =====

  app.get("/api/stories/:id/compile", async (c) => {
    const id = Number(c.req.param("id"));
    const formatRaw = c.req.query("format") ?? "md";
    const format = ["md", "html", "docx"].includes(formatRaw)
      ? (formatRaw as "md" | "html" | "docx")
      : "md";
    try {
      const r = await compileStory(cfg, db, id, format);
      const buf = await fsReadFile(r.outAbs);
      const mime =
        format === "html"
          ? "text/html; charset=utf-8"
          : format === "docx"
          ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          : "text/markdown; charset=utf-8";
      return new Response(buf, {
        headers: {
          "Content-Type": mime,
          "Content-Disposition": `attachment; filename="${r.filename}"`,
          "X-Quill-Compile-Path": r.outAbs,
        },
      });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.post("/api/research/clip", async (c) => {
    const parsed = ClipBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "bad request", issues: parsed.error.flatten() }, 400);
    try {
      const r = await clipUrl(cfg, parsed.data.url, { topic: parsed.data.topic });
      return c.json(r);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.get("/api/stories/:id/beats", async (c) => {
    const id = Number(c.req.param("id"));
    try {
      const r = await buildBeats(cfg, db, id);
      return c.json(r);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 404);
    }
  });

  app.get("/api/pronunciation", async (c) => {
    return c.json(await loadPronunciationMap(cfg));
  });

  app.put("/api/pronunciation", async (c) => {
    const map = (await c.req.json().catch(() => ({}))) as Record<string, string>;
    await savePronunciationMap(cfg, map);
    return c.json({ ok: true });
  });

  app.post("/api/series/rename", async (c) => {
    const parsed = RenameBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "bad request", issues: parsed.error.flatten() }, 400);
    const { series, needle, replacement, wholeWord = true, apply = false } = parsed.data;
    if (apply) {
      const r = await applyRename(cfg, db, series, needle, replacement, wholeWord);
      return c.json({ apply: true, ...r });
    }
    const r = await previewRename(cfg, series, needle, replacement, wholeWord);
    return c.json(r);
  });

  app.get("/api/stories/:id/calendar.ics", (c) => {
    const id = Number(c.req.param("id"));
    try {
      const r = buildIcsForStory(db, id, {});
      return new Response(r.payload, {
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "Content-Disposition": `attachment; filename="${r.filename}"`,
        },
      });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 404);
    }
  });

  // ===== Inspirations =====
  app.get("/api/stories/:id/inspirations", (c) => {
    const id = Number(c.req.param("id"));
    return c.json({ inspirations: listInspirations(db, id) });
  });
  app.post("/api/stories/:id/inspirations", async (c) => {
    const id = Number(c.req.param("id"));
    const body = (await c.req.json().catch(() => ({}))) as {
      kind?: string;
      url?: string;
      content?: string;
      caption?: string;
    };
    if (!body.kind || !["image", "quote", "link", "note"].includes(body.kind)) {
      return c.json({ error: "kind required" }, 400);
    }
    return c.json(addInspiration(db, id, body as { kind: InspirationKind }));
  });
  app.delete("/api/inspirations/:id", (c) => {
    const id = Number(c.req.param("id"));
    return c.json({ ok: deleteInspiration(db, id) });
  });

  // ===== Submissions =====
  app.get("/api/stories/:id/submissions", (c) => {
    const id = Number(c.req.param("id"));
    return c.json({ submissions: listSubmissions(db, id) });
  });
  app.post("/api/stories/:id/submissions", async (c) => {
    const id = Number(c.req.param("id"));
    const body = (await c.req.json().catch(() => ({}))) as {
      agent?: string;
      agency?: string;
      notes?: string;
    };
    if (!body.agent) return c.json({ error: "agent required" }, 400);
    return c.json(createSubmission(db, id, body as { agent: string }));
  });
  app.patch("/api/submissions/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const body = await c.req.json().catch(() => ({}));
    const r = updateSubmission(db, id, body);
    if (!r) return c.json({ error: "not found" }, 404);
    return c.json(r);
  });
  app.delete("/api/submissions/:id", (c) => {
    const id = Number(c.req.param("id"));
    return c.json({ ok: deleteSubmission(db, id) });
  });

  // ===== Share links =====
  app.get("/api/share-links", (c) => c.json({ links: listShareLinks(db) }));
  app.post("/api/share-links", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      filePath?: string;
      label?: string;
      expiresAtMs?: number | null;
    };
    if (!body.filePath) return c.json({ error: "filePath required" }, 400);
    return c.json(createShareLink(db, body.filePath, body.label, body.expiresAtMs ?? null));
  });
  app.delete("/api/share-links/:id", (c) => {
    const id = Number(c.req.param("id"));
    return c.json({ ok: revokeShareLink(db, id) });
  });
  // Public read by token (auth bypassed via apiAuth /api/share/ exception)
  app.get("/api/share/:token", async (c) => {
    const token = c.req.param("token");
    const link = getShareLinkByToken(db, token);
    if (!link) return c.json({ error: "invalid token" }, 404);
    if (link.expires_at && Date.now() > link.expires_at) {
      return c.json({ error: "expired" }, 410);
    }
    try {
      const r = await readSharedFile(cfg, link);
      return c.json({
        label: link.label,
        filePath: link.file_path,
        content: r.content,
        bytes: r.bytes,
      });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 404);
    }
  });

  app.get("/api/stories/:id/glossary", async (c) => {
    const id = Number(c.req.param("id"));
    try {
      const r = await buildGlossary(cfg, db, id);
      return c.json(r);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 404);
    }
  });

  // ===== Dashboard / goals / time =====

  app.get("/api/stories/:id/goals", (c) => {
    const id = Number(c.req.param("id"));
    return c.json({ goals: listGoals(db, id) });
  });

  app.post("/api/stories/:id/goals", async (c) => {
    const id = Number(c.req.param("id"));
    const parsed = GoalBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "bad request", issues: parsed.error.flatten() }, 400);
    const g = upsertGoal(
      db,
      id,
      parsed.data.kind as GoalKind,
      parsed.data.target ?? null,
      parsed.data.deadline_ms ?? null
    );
    return c.json(g);
  });

  app.delete("/api/goals/:id", (c) => {
    const id = Number(c.req.param("id"));
    return c.json({ ok: deleteGoal(db, id) });
  });

  app.post("/api/stories/:id/sessions/start", async (c) => {
    const id = Number(c.req.param("id"));
    const parsed = SessionStartBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "bad request", issues: parsed.error.flatten() }, 400);
    return c.json(startSession(db, id, parsed.data.filePath));
  });

  app.post("/api/sessions/heartbeat", async (c) => {
    const parsed = SessionHeartbeatBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "bad request", issues: parsed.error.flatten() }, 400);
    const r = heartbeat(db, parsed.data.sessionId);
    if (!r) return c.json({ error: "not found" }, 404);
    return c.json(r);
  });

  app.post("/api/sessions/end", async (c) => {
    const parsed = SessionHeartbeatBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "bad request", issues: parsed.error.flatten() }, 400);
    const r = endSession(db, parsed.data.sessionId);
    if (!r) return c.json({ error: "not found" }, 404);
    return c.json(r);
  });

  app.get("/api/stories/:id/sessions", (c) => {
    const id = Number(c.req.param("id"));
    const days = Number(c.req.query("days") ?? 30);
    return c.json({ sessions: recentSessions(db, id, days) });
  });

  app.post("/api/stories/:id/daylog", async (c) => {
    const id = Number(c.req.param("id"));
    const parsed = DayLogBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "bad request", issues: parsed.error.flatten() }, 400);
    return c.json(logWordsForDay(db, id, parsed.data.day, parsed.data.wordsAtEnd));
  });

  app.get("/api/stories/:id/daylog", (c) => {
    const id = Number(c.req.param("id"));
    const days = Number(c.req.query("days") ?? 30);
    return c.json({ days: dailyLog(db, id, days) });
  });

  app.post("/api/stories/:id/branch", async (c) => {
    const id = Number(c.req.param("id"));
    const parsed = BranchBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "bad request", issues: parsed.error.flatten() }, 400);
    try {
      const r = branchStory(db, id, parsed.data.label);
      return c.json(r);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.get("/api/stories/:id/reading", async (c) => {
    const id = Number(c.req.param("id"));
    try {
      const r = await buildReadingPass(cfg, db, id);
      return c.json(r);
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : String(e) },
        404
      );
    }
  });

  // ===== Ensemble (multi-agent parallel chat) =====

  app.post("/api/stories/:id/ensemble", async (c) => {
    const id = Number(c.req.param("id"));
    const story = getStory(db, id);
    if (!story) return c.json({ error: "story not found" }, 404);
    const parsed = EnsembleBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "bad request", issues: parsed.error.flatten() }, 400);
    }
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        const send = (event: string, data: unknown): void => {
          controller.enqueue(
            enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        };
        try {
          for await (const ev of runEnsemble(cfg, db, {
            storyId: id,
            message: parsed.data.message,
            agents: parsed.data.agents,
          })) {
            send(ev.type, ev);
          }
        } catch (e) {
          send("error", { error: e instanceof Error ? e.message : String(e) });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  });

  // ===== Workflows =====

  app.get("/api/workflows", (c) => c.json({ workflows: listWorkflows() }));

  // Run a workflow: builds the prompt server-side, pins agent, streams via runChat.
  app.post("/api/stories/:id/workflow", async (c) => {
    const id = Number(c.req.param("id"));
    const story = getStory(db, id);
    if (!story) return c.json({ error: "story not found" }, 404);
    const parsed = WorkflowRunBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "bad request", issues: parsed.error.flatten() }, 400);
    const wf = getWorkflow(parsed.data.workflowId);
    if (!wf) return c.json({ error: "unknown workflow" }, 404);

    const message = wf.buildPrompt(parsed.data.inputs);

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        const send = (event: string, data: unknown) => {
          controller.enqueue(
            enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        };
        try {
          for await (const ev of runChat(cfg, db, {
            storyId: id,
            message,
            agent: wf.agent,
          })) {
            send(ev.type, ev);
          }
        } catch (e) {
          send("error", { error: e instanceof Error ? e.message : String(e) });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  });

  // SSE streaming chat. Path includes story id; body has message + agent.
  app.post("/api/stories/:id/chat", async (c) => {
    const id = Number(c.req.param("id"));
    const story = getStory(db, id);
    if (!story) return c.json({ error: "story not found" }, 404);
    const parsed = ChatBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "bad request", issues: parsed.error.flatten() }, 400);

    const { message, agent, mode } = parsed.data;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        const send = (event: string, data: unknown) => {
          controller.enqueue(
            enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        };
        try {
          for await (const ev of runChat(cfg, db, {
            storyId: id,
            message,
            agent: agent as AgentSelection,
            mode,
          })) {
            send(ev.type, ev);
          }
        } catch (e) {
          send("error", { error: e instanceof Error ? e.message : String(e) });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  });

  // Knowledge layer: on-demand canon extraction for a story (entities/facts/edges).
  app.post("/api/stories/:id/kb/extract", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
    try {
      const result = await extractStory(cfg, db, id);
      return c.json(result);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.get("/api/stories/:id/kb/stats", (c) => {
    const story = getStory(db, Number(c.req.param("id")));
    const series = story?.series ?? undefined;
    return c.json({
      entities: entityCount(db, series),
      facts: factCount(db, series),
      pending: pendingCount(db, story?.series ?? null),
    });
  });

  // Self-building canon — scan prose (one file via ?path=, or whole story) and
  // queue candidate facts classified new/contradicts for review.
  app.post("/api/stories/:id/kb/propose", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { path?: string };
    try {
      const result = await proposeFromStory(cfg, db, id, body.path ?? null);
      return c.json(result);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.get("/api/stories/:id/kb/pending", (c) => {
    const story = getStory(db, Number(c.req.param("id")));
    if (!story) return c.json({ error: "story not found" }, 404);
    return c.json({ pending: listPending(db, story.series) });
  });

  app.post("/api/stories/:id/kb/pending/:pid/accept", (c) => {
    const pid = Number(c.req.param("pid"));
    if (!Number.isFinite(pid)) return c.json({ error: "bad id" }, 400);
    try {
      return c.json(acceptPending(db, pid));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  app.post("/api/stories/:id/kb/pending/:pid/reject", (c) => {
    const pid = Number(c.req.param("pid"));
    if (!Number.isFinite(pid)) return c.json({ error: "bad id" }, 400);
    try {
      rejectPending(db, pid);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  app.post("/api/stories/:id/kb/pending/clear", (c) => {
    const story = getStory(db, Number(c.req.param("id")));
    if (!story) return c.json({ error: "story not found" }, 404);
    return c.json({ cleared: clearPending(db, story.series) });
  });

  // Timeline + character-knowledge state: the reveal timeline (bounded facts)
  // plus, when ?chapter= is given, canon as-of that chapter (active vs future).
  app.get("/api/stories/:id/kb/timeline", (c) => {
    const story = getStory(db, Number(c.req.param("id")));
    if (!story) return c.json({ error: "story not found" }, 404);
    const series = story.series;
    const book = story.name;
    const chapterRaw = c.req.query("chapter");
    const events = timelineEvents(db, series, book);
    const max = maxChapter(db, series);
    if (chapterRaw != null && chapterRaw !== "") {
      const chapter = Number(chapterRaw);
      const state = knowledgeStateAt(db, series, book, chapter);
      return c.json({ events, maxChapter: max, state });
    }
    return c.json({ events, maxChapter: max, state: null });
  });

  app.post("/api/stories/:id/kb/facts/:fid/bounds", async (c) => {
    const fid = Number(c.req.param("fid"));
    if (!Number.isFinite(fid)) return c.json({ error: "bad id" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as {
      fromChapter?: number | null;
      toChapter?: number | null;
      fromBook?: string | null;
      toBook?: string | null;
    };
    try {
      setFactBounds(db, fid, {
        fromBook: body.fromBook ?? null,
        fromChapter: body.fromChapter ?? null,
        toBook: body.toBook ?? null,
        toChapter: body.toChapter ?? null,
      });
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  // Canon-aware retrieval scoped to a story's series/book.
  app.get("/api/stories/:id/kb/search", async (c) => {
    const story = getStory(db, Number(c.req.param("id")));
    if (!story) return c.json({ error: "story not found" }, 404);
    const q = c.req.query("q") ?? "";
    if (!q.trim()) return c.json({ error: "q required" }, 400);
    const items = await retrieveCanon(cfg, db, q, {
      scope: { series: story.series, book: story.name },
      factK: Number(c.req.query("facts") ?? 8),
      chunkK: Number(c.req.query("chunks") ?? 6),
    });
    return c.json({ items });
  });

  // Canon graph: entities (+ aliases, fact counts) and their relationship edges.
  app.get("/api/stories/:id/kb/graph", (c) => {
    const story = getStory(db, Number(c.req.param("id")));
    if (!story) return c.json({ error: "story not found" }, 404);
    return c.json(listGraph(db, story.series));
  });

  // Facts attached to one entity (with ids, so the UI can open per-fact history).
  app.get("/api/stories/:id/kb/entities/:eid/facts", (c) => {
    const story = getStory(db, Number(c.req.param("id")));
    if (!story) return c.json({ error: "story not found" }, 404);
    const eid = Number(c.req.param("eid"));
    if (!Number.isFinite(eid)) return c.json({ error: "bad entity id" }, 400);
    return c.json({ facts: entityFacts(db, eid) });
  });

  // A single fact's change log (create / reweight / etc.).
  app.get("/api/stories/:id/kb/facts/:fid/history", (c) => {
    const story = getStory(db, Number(c.req.param("id")));
    if (!story) return c.json({ error: "story not found" }, 404);
    const fid = Number(c.req.param("fid"));
    if (!Number.isFinite(fid)) return c.json({ error: "bad fact id" }, 400);
    return c.json({ history: factHistory(db, fid) });
  });

  // Continuity audit of a draft file against the story's series canon.
  app.get("/api/stories/:id/kb/continuity", async (c) => {
    const story = getStory(db, Number(c.req.param("id")));
    if (!story) return c.json({ error: "story not found" }, 404);
    const file = c.req.query("file");
    if (!file) return c.json({ error: "file required" }, 400);
    const useLlm = c.req.query("llm") !== "false";
    try {
      const issues = await checkContinuityFile(cfg, db, { series: story.series, file, useLlm });
      return c.json({ issues });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  // Continuity audit of raw text (the editor's unsaved buffer) against canon.
  app.post("/api/stories/:id/kb/continuity", async (c) => {
    const story = getStory(db, Number(c.req.param("id")));
    if (!story) return c.json({ error: "story not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      text?: unknown;
      llm?: unknown;
    };
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) return c.json({ error: "text required" }, 400);
    const useLlm = body.llm !== false;
    try {
      const issues = await checkContinuity(cfg, db, {
        series: story.series,
        text,
        useLlm,
      });
      return c.json({ issues });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  // Story-structure: beat-sheet alignment + pacing outliers.
  app.get("/api/stories/:id/kb/beats", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
    try {
      return c.json(await alignBeats(cfg, db, id, c.req.query("template") ?? "save-the-cat"));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.get("/api/stories/:id/kb/pacing", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
    try {
      return c.json(await pacingReport(cfg, db, id));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  // Canon snapshots: freeze / list / diff the series' entity+fact state.
  app.get("/api/stories/:id/kb/snapshots", (c) => {
    const story = getStory(db, Number(c.req.param("id")));
    if (!story) return c.json({ error: "story not found" }, 404);
    return c.json({ snapshots: listSnapshots(db, story.series) });
  });

  app.post("/api/stories/:id/kb/snapshots", async (c) => {
    const story = getStory(db, Number(c.req.param("id")));
    if (!story) return c.json({ error: "story not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: unknown;
      note?: unknown;
    };
    const name =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : new Date().toISOString();
    const note = typeof body.note === "string" ? body.note : undefined;
    try {
      const snapshotId = createSnapshot(db, story.series, name, note);
      return c.json({ id: snapshotId, name });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.get("/api/stories/:id/kb/snapshots/diff", (c) => {
    const a = Number(c.req.query("a"));
    const b = Number(c.req.query("b"));
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return c.json({ error: "a and b required" }, 400);
    }
    try {
      return c.json({ diffs: diffSnapshots(db, a, b) });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 404);
    }
  });

  // Open any folder under the writing root as a chat workspace: auto-registers
  // it as a story, derives series/book scope, and the ensuing chat runs cwd'd in
  // that folder so its layered CLAUDE.md applies.
  app.post("/api/workspace/open", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { path?: unknown };
    const path = typeof body.path === "string" ? body.path : "";
    if (!path) return c.json({ error: "path required" }, 400);
    try {
      const ws = openWorkspace(cfg, db, path);
      return c.json({ story: ws.story, scope: ws.scope, folder: ws.cwd });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  app.post("/api/stories/:id/regenerate", async (c) => {
    const id = Number(c.req.param("id"));
    const story = getStory(db, id);
    if (!story) return c.json({ error: "story not found" }, 404);
    const parsed = RegenerateBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "bad request", issues: parsed.error.flatten() }, 400);
    }
    const { fromMessageId, agent, editedContent } = parsed.data;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        const send = (event: string, data: unknown) => {
          controller.enqueue(
            enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        };
        try {
          for await (const ev of runChatRegenerate(cfg, db, {
            storyId: id,
            fromMessageId,
            agent: agent as AgentSelection,
            editedContent,
          })) {
            send(ev.type, ev);
          }
        } catch (e) {
          send("error", { error: e instanceof Error ? e.message : String(e) });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  });

  // ===== Usage =====

  app.get("/api/usage", (c) => {
    const storyIdRaw = c.req.query("storyId");
    const sinceRaw = c.req.query("since");
    const storyId = storyIdRaw ? Number(storyIdRaw) : undefined;
    const since = sinceRaw ? Number(sinceRaw) : undefined;
    const events = listUsageEvents(db, { storyId, since });
    const { perAgent, totals } = usageRollup(db, { storyId, since });
    return c.json({ events, totals: perAgent, summary: totals });
  });

  app.get("/api/usage/totals", (c) => {
    const sinceRaw = c.req.query("since");
    const since = sinceRaw ? Number(sinceRaw) : undefined;
    return c.json(usageRollup(db, { since }));
  });

  // Static SPA: web/dist served at root. SPA fallback to index.html.
  const webDist = join(import.meta.dir, "..", "web", "dist");
  if (existsSync(webDist)) {
    app.use("/assets/*", serveStatic({ root: "./web/dist" }));
    app.get("/", serveStatic({ path: "./web/dist/index.html" }));
    app.get("*", serveStatic({ path: "./web/dist/index.html" }));
  }

  return app;
}

export function serve(cfg: Config): void {
  const app = buildApp(cfg);
  const port = cfg.HTTP_PORT;
  const host = cfg.HTTP_HOST;
  const tokenStatus = cfg.HTTP_TOKEN
    ? "auth: bearer required"
    : "auth: DISABLED (set HTTP_TOKEN to enable)";
  if (host !== "127.0.0.1" && host !== "localhost" && !cfg.HTTP_TOKEN) {
    console.warn(
      `quill: WARNING binding ${host} with no HTTP_TOKEN — the API is exposed unauthenticated.`
    );
  }
  Bun.serve({
    port,
    hostname: host,
    fetch: app.fetch,
    idleTimeout: 255, // Bun max; chat streams may run minutes
  });
  console.log(`quill http on http://${host}:${port}  (${tokenStatus})`);
}
