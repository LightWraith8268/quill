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
import type { AgentSelection } from "./agents/router.ts";
import { listWorkflows, getWorkflow } from "./workflows.ts";
import { vaultTree, readVaultFile, scanEntities, resolveWikiTarget } from "./vault.ts";
import {
  createDraft,
  listAllDrafts,
  listDraftsForFile,
  getDraft,
  deleteDraft,
} from "./drafts.ts";
import { checkHealth } from "./health.ts";
import { logError, recentErrors } from "./errlog.ts";
import { listUsageEvents, usageRollup } from "./usage.ts";

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
});

const ChatBody = z.object({
  message: z.string().min(1),
  agent: z.enum(["claude", "codex", "gemini", "auto"]).default("auto"),
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

export function buildApp(cfg: Config) {
  const app = new Hono();
  const db = openDb(cfg);

  const apiAuth = async (
    c: { req: { header: (k: string) => string | undefined; path: string }; json: (b: unknown, s?: number) => Response },
    next: () => Promise<void>
  ): Promise<void | Response> => {
    if (!cfg.HTTP_TOKEN) return next();
    if (c.req.path === "/api/health") return next();
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

  // ===== Lore / entities =====

  app.get("/api/lore/entities", async (c) => {
    const entities = await scanEntities(cfg);
    return c.json({ entities });
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

    const { message, agent } = parsed.data;
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
  const tokenStatus = cfg.HTTP_TOKEN
    ? "auth: bearer required"
    : "auth: DISABLED (set HTTP_TOKEN to enable)";
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: app.fetch,
    idleTimeout: 255, // Bun max; chat streams may run minutes
  });
  console.log(`quill http on http://127.0.0.1:${port}  (${tokenStatus})`);
}
