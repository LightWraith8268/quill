// Chat orchestration. Build per-story context (style + bibles + RAG hits + history),
// stream from agent, persist messages.

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { readVaultFile } from "./vault.ts";
import type { DB } from "./db.ts";
import type { Story } from "./stories.ts";
import { getStory } from "./stories.ts";
import {
  listMessages,
  appendMessage,
  getMessage,
  updateMessageContent,
  deleteFromMessage,
  truncateAfterMessage,
  type Message,
} from "./messages.ts";
import { composeStyle } from "./style.ts";
import { retrieveCanon } from "./knowledge/retrieve.ts";
import { renderCanonPack } from "./knowledge/contextpack.ts";
import { storyCwd } from "./workspace.ts";
import { pickAgent, streamFor, type AgentName, type AgentSelection } from "./agents/router.ts";
import { makeRecorder } from "./usage.ts";

const HISTORY_TURNS = 12;
const LORE_HITS = 5;

// Appended to the system prompt in agent mode so Claude knows it may act on the
// vault directly (it has Read/Write/Edit/Grep/Glob/Bash in the story folder).
const AGENT_MODE_INSTRUCTIONS = [
  `=== AGENT MODE ===`,
  `You can directly read, search, and edit files in this story folder using your tools — you are not limited to the context above. Prefer reading the actual files when you need specifics.`,
  `When the user asks you to write or revise prose, edit the relevant manuscript file in place (Edit/Write) rather than only printing the text in chat. After editing, briefly summarize what you changed and where.`,
  `Stay inside this story folder. Do not run destructive shell commands. Keep manuscript files clean markdown — no code fences around prose.`,
].join("\n");
const CANON_FACTS = 8;
const STYLE_LORE_PREVIEW_CHARS = 600;
const ACTIVE_SCENE_LARGE_BYTES = 30 * 1024;
const AUTO_SCENE_MTIME_WINDOW_MS = 30 * 60 * 1000;

async function findRecentScene(
  cfg: Config,
  storyPath: string
): Promise<{ relPath: string; mtimeMs: number } | null> {
  const root = join(cfg.VAULT_PATH, storyPath);
  let best: { relPath: string; mtimeMs: number } | null = null;
  const walk = async (absDir: string, relDir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = join(absDir, e.name);
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(abs, rel);
      } else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) {
        try {
          const st = await stat(abs);
          if (!best || st.mtimeMs > best.mtimeMs) {
            best = { relPath: `${storyPath}/${rel}`, mtimeMs: st.mtimeMs };
          }
        } catch {
          /* skip */
        }
      }
    }
  };
  await walk(root, "");
  return best;
}

export type { AgentName } from "./agents/router.ts";

// Compact human label for a tool call, shown as a chip in the chat UI.
function toolDetailFor(name: string, input: unknown): string | undefined {
  const i = (input ?? {}) as Record<string, unknown>;
  const base = (p: unknown): string | undefined =>
    typeof p === "string" ? p.split(/[\\/]/).pop() : undefined;
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return base(i.file_path ?? i.notebook_path);
    case "Grep":
      return typeof i.pattern === "string" ? `/${i.pattern}/` : undefined;
    case "Glob":
      return typeof i.pattern === "string" ? i.pattern : undefined;
    case "Bash":
      return typeof i.command === "string" ? i.command.slice(0, 60) : undefined;
    default:
      return undefined;
  }
}

export type ChatRequest = {
  storyId: number;
  message: string;
  agent: AgentSelection;
  // "agent" = let Claude read/write/edit/search the vault (bypassPermissions,
  // sandboxed to the story folder). "chat" (default) = advisory, no tools.
  mode?: "chat" | "agent";
};

export type ToolUse = { name: string; ok: boolean; detail?: string };

export type ChatStreamEvent =
  | { type: "context"; usage: ContextUsage; agent: AgentName; routeReason: string }
  | { type: "delta"; text: string }
  | { type: "tool"; phase: "start" | "end"; id: string; name?: string; detail?: string; ok?: boolean }
  | { type: "done"; assistantId: number }
  | { type: "error"; error: string };

export type ContextUsage = {
  style: { base: string | null; genres: string[] } | null;
  bibles: string[]; // file paths included
  loreHits: { path: string; heading: string | null; score: number }[];
  canonFacts?: number;
  historyTurns: number;
  activeScene?: { path: string; bytes: number; source: "pinned" | "auto-mtime" } | null;
  tools?: ToolUse[]; // agent-mode vault actions taken this turn
};

export async function* runChat(
  cfg: Config,
  db: DB,
  req: ChatRequest
): AsyncGenerator<ChatStreamEvent, void, void> {
  const story = getStory(db, req.storyId);
  if (!story) {
    yield { type: "error", error: `story ${req.storyId} not found` };
    return;
  }

  const history = listMessages(db, story.id, HISTORY_TURNS * 2);

  // Persist user message immediately (so chat list shows it during streaming)
  appendMessage(db, {
    storyId: story.id,
    role: "user",
    content: req.message,
  });

  const t0 = Date.now();
  const built = await buildContext(cfg, db, story, history, req.message);
  const contextMs = Date.now() - t0;
  // Note: buildContext already recorded embed+rerank usage internally.
  // Agent mode needs the tool-capable agent (Claude), so pin it there.
  const isAgent = req.mode === "agent";
  const route = isAgent
    ? { agent: "claude" as AgentName, reason: "agent mode → Claude (vault tools)" }
    : pickAgent(req.agent, req.message);
  yield { type: "context", usage: built.usage, agent: route.agent, routeReason: route.reason };

  const systemPrompt = isAgent
    ? built.systemPrompt + "\n\n" + AGENT_MODE_INSTRUCTIONS
    : built.systemPrompt;
  const userPrompt = req.message;

  const agentRecorder = makeRecorder(db, route.agent, story.id);

  // Bridge claude.ts onToolCall (sync callback) → generator yields. Tool events
  // fire between text chunks; queue them and drain on each iteration.
  const toolQueue: ChatStreamEvent[] = [];
  const toolDetail = new Map<string, { name: string; detail?: string }>();
  const tools: ToolUse[] = [];

  let full = "";
  let ttftMs = 0;
  const tStream = Date.now();
  try {
    const stream = streamFor(route.agent, userPrompt, {
      systemPrompt,
      cwd: storyCwd(cfg, story),
      agentic: isAgent,
      onToolCall: (e) => {
        if (e.phase === "start") {
          const detail = toolDetailFor(e.name, e.input);
          toolDetail.set(e.id, { name: e.name, detail });
          toolQueue.push({ type: "tool", phase: "start", id: e.id, name: e.name, detail });
        } else {
          const meta = toolDetail.get(e.id);
          tools.push({ name: meta?.name ?? "tool", ok: e.ok, detail: meta?.detail });
          toolQueue.push({ type: "tool", phase: "end", id: e.id, ok: e.ok });
        }
      },
      onUsage: (u) => agentRecorder({
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cachedInputTokens: u.cachedInputTokens,
        model: u.model,
      }),
    });
    for await (const chunk of stream) {
      while (toolQueue.length) yield toolQueue.shift()!;
      if (ttftMs === 0) ttftMs = Date.now() - tStream;
      full += chunk;
      yield { type: "delta", text: chunk };
    }
    while (toolQueue.length) yield toolQueue.shift()!;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    yield { type: "error", error: msg };
    return;
  }

  if (tools.length) built.usage.tools = tools;

  const assistant = appendMessage(db, {
    storyId: story.id,
    role: "assistant",
    agent: route.agent,
    content: full,
    contextUsed: { ...built.usage, routedAgent: route.agent, routeReason: route.reason },
  });
  console.log(
    JSON.stringify({
      type: "chat_timing",
      agent: route.agent,
      contextMs,
      ttftMs,
      totalMs: Date.now() - t0,
      chars: full.length,
    })
  );
  yield { type: "done", assistantId: assistant.id };
}

export type RegenerateRequest = {
  storyId: number;
  fromMessageId: number;
  agent: AgentSelection;
  editedContent?: string;
};

export async function* runChatRegenerate(
  cfg: Config,
  db: DB,
  req: RegenerateRequest
): AsyncGenerator<ChatStreamEvent, void, void> {
  const story = getStory(db, req.storyId);
  if (!story) {
    yield { type: "error", error: `story ${req.storyId} not found` };
    return;
  }

  const target = getMessage(db, req.fromMessageId);
  if (!target || target.story_id !== req.storyId) {
    yield {
      type: "error",
      error: `message ${req.fromMessageId} not found in story ${req.storyId}`,
    };
    return;
  }

  let userPrompt: string;

  if (req.editedContent !== undefined) {
    if (target.role !== "user") {
      yield {
        type: "error",
        error: "editedContent provided but target is not a user message",
      };
      return;
    }
    updateMessageContent(db, req.fromMessageId, req.editedContent);
    truncateAfterMessage(db, req.storyId, req.fromMessageId);
    userPrompt = req.editedContent;
  } else {
    if (target.role !== "assistant") {
      yield {
        type: "error",
        error: "no editedContent and target is not an assistant message",
      };
      return;
    }
    deleteFromMessage(db, req.storyId, req.fromMessageId);
    const remaining = listMessages(db, req.storyId, 200);
    const lastUser = [...remaining].reverse().find((m) => m.role === "user");
    if (!lastUser) {
      yield {
        type: "error",
        error: "no preceding user message found to regenerate from",
      };
      return;
    }
    userPrompt = lastUser.content;
  }

  const fullHistory = listMessages(db, story.id, HISTORY_TURNS * 2);
  const priorHistory = fullHistory.slice(0, -1);

  const built = await buildContext(cfg, db, story, priorHistory, userPrompt);
  const route = pickAgent(req.agent, userPrompt);
  yield {
    type: "context",
    usage: built.usage,
    agent: route.agent,
    routeReason: route.reason,
  };

  const agentRecorder = makeRecorder(db, route.agent, story.id);

  let full = "";
  try {
    for await (const chunk of streamFor(route.agent, userPrompt, {
      systemPrompt: built.systemPrompt,
      cwd: storyCwd(cfg, story),
      onUsage: (u) =>
        agentRecorder({
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cachedInputTokens: u.cachedInputTokens,
          model: u.model,
        }),
    })) {
      full += chunk;
      yield { type: "delta", text: chunk };
    }
  } catch (e) {
    yield { type: "error", error: e instanceof Error ? e.message : String(e) };
    return;
  }

  const assistant = appendMessage(db, {
    storyId: story.id,
    role: "assistant",
    agent: route.agent,
    content: full,
    contextUsed: {
      ...built.usage,
      routedAgent: route.agent,
      routeReason: route.reason,
      regeneratedFrom: req.fromMessageId,
    },
  });
  yield { type: "done", assistantId: assistant.id };
}

async function buildContext(
  cfg: Config,
  db: DB,
  story: Story,
  history: Message[],
  userMessage: string
): Promise<{ systemPrompt: string; usage: ContextUsage }> {
  const parts: string[] = [];
  const usage: ContextUsage = {
    style: null,
    bibles: [],
    loreHits: [],
    canonFacts: 0,
    historyTurns: history.length,
    activeScene: null,
  };

  parts.push(
    `You are an expert co-writer working on a specific story in the user's vault.`,
    ``,
    `Active story: ${story.name}`,
    `Series: ${story.series ?? "(unknown)"}`,
    `Story path: ${story.path}`,
    ``
  );

  // 1. Style profile (composed)
  if (story.active_style) {
    try {
      const composed = await composeStyle(cfg, story.active_style, story.active_genres);
      if (composed) {
        usage.style = {
          base: composed.base.name,
          genres: composed.genres.map((g) => g.name),
        };
        parts.push(
          `=== ACTIVE STYLE PROFILE (genre-neutral base + overlays) ===`,
          composed.content,
          ``
        );
      }
    } catch {
      /* ignore */
    }
  }

  // 2. Series-level bibles
  if (story.series) {
    const seriesAbs = join(cfg.VAULT_PATH, "Books", story.series);
    const candidates = [
      "CHARACTER_BIBLE.md",
      "World Bible v2.md",
      "CANON_REFERENCE_SUMMARY.md",
      "SYSTEM_RULES_TABLE.md",
      "TIMELINE_SCENE_GRID.md",
    ];
    for (const f of candidates) {
      try {
        const content = await readFile(join(seriesAbs, f), "utf-8");
        const rel = `Books/${story.series}/${f}`;
        usage.bibles.push(rel);
        parts.push(`=== SERIES REFERENCE: ${rel} ===`, content, ``);
      } catch {
        /* file may not exist for this series; skip */
      }
    }
  }

  // 2.5 Active scene file (pinned by user OR auto-detected via mtime)
  let activeSceneBytes = 0;
  let scenePath: string | null = story.active_scene_path ?? null;
  let sceneSource: "pinned" | "auto-mtime" = "pinned";
  if (!scenePath) {
    try {
      const recent = await findRecentScene(cfg, story.path);
      if (recent && Date.now() - recent.mtimeMs <= AUTO_SCENE_MTIME_WINDOW_MS) {
        scenePath = recent.relPath;
        sceneSource = "auto-mtime";
      }
    } catch {
      /* ignore */
    }
  }
  if (scenePath) {
    try {
      const file = await readVaultFile(cfg, scenePath);
      activeSceneBytes = file.bytes;
      usage.activeScene = { path: scenePath, bytes: file.bytes, source: sceneSource };
      parts.push(
        `=== ACTIVE SCENE FILE: ${scenePath} ===`,
        file.content,
        ``
      );
    } catch {
      /* file may have moved; skip silently */
    }
  }

  // 3. Canon-aware retrieval — scoped to this series/book: canon facts (ranked
  //    by canon weight) + relevant manuscript chunks, rendered as a canon-
  //    labeled pack so the model grounds on locked canon, not drafts.
  const skipRag = activeSceneBytes > ACTIVE_SCENE_LARGE_BYTES;
  if (!skipRag) try {
    const last = history.slice(-2).map((m) => m.content).join("\n");
    const queryText = (last ? last + "\n" : "") + userMessage;
    const embedRec = makeRecorder(db, "voyage_embed", story.id);
    const rerankRec = makeRecorder(db, "voyage_rerank", story.id);
    const items = await retrieveCanon(cfg, db, queryText, {
      scope: { series: story.series, book: story.name },
      factK: CANON_FACTS,
      chunkK: LORE_HITS,
      useRerank: true,
      onEmbedUsage: embedRec,
      onRerankUsage: rerankRec,
    });
    const chunks = items.filter((i) => i.kind === "chunk");
    const facts = items.filter((i) => i.kind !== "chunk");
    usage.loreHits = chunks.map((h) => ({
      path: h.sourcePath ?? "",
      heading: h.sourceRef,
      score: h.score,
    }));
    usage.canonFacts = facts.length;
    const pack = renderCanonPack(facts, chunks, { previewChars: STYLE_LORE_PREVIEW_CHARS });
    if (pack) parts.push(pack);
  } catch {
    /* retrieval failure non-fatal */
  }

  // 4. Recent chat history (last N turns, excluding the user message we just appended)
  const recent = history.slice(-(HISTORY_TURNS * 2));
  if (recent.length > 0) {
    parts.push(`=== RECENT CHAT HISTORY (most recent last) ===`);
    for (const m of recent) {
      const tag = m.role === "user" ? "USER" : m.agent ? m.agent.toUpperCase() : "ASSISTANT";
      parts.push(`<${tag}>`);
      parts.push(m.content);
      parts.push(`</${tag}>`);
    }
    parts.push("");
  }

  parts.push(
    `=== INSTRUCTIONS ===`,
    `Apply the active style profile rigorously. Respect canon in the series bible(s) above. Use the lore retrieval to ground specifics; quote or cite a source path when you rely on it. Avoid the anti-patterns named in the style profile. Reply in the user's preferred mode (drafting, revision, brainstorming) — infer from the message.`
  );

  return { systemPrompt: parts.join("\n"), usage };
}
