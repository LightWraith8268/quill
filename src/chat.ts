// Chat orchestration. Build per-story context (style + bibles + RAG hits + history),
// stream from agent, persist messages.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
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
import { search, type SearchHit } from "./search.ts";
import { pickAgent, streamFor, type AgentName, type AgentSelection } from "./agents/router.ts";
import { makeRecorder } from "./usage.ts";

const HISTORY_TURNS = 12;
const LORE_HITS = 5;
const STYLE_LORE_PREVIEW_CHARS = 600;

export type { AgentName } from "./agents/router.ts";

export type ChatRequest = {
  storyId: number;
  message: string;
  agent: AgentSelection;
};

export type ChatStreamEvent =
  | { type: "context"; usage: ContextUsage; agent: AgentName; routeReason: string }
  | { type: "delta"; text: string }
  | { type: "done"; assistantId: number }
  | { type: "error"; error: string };

export type ContextUsage = {
  style: { base: string | null; genres: string[] } | null;
  bibles: string[]; // file paths included
  loreHits: { path: string; heading: string | null; score: number }[];
  historyTurns: number;
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

  const built = await buildContext(cfg, db, story, history, req.message);
  // Note: buildContext already recorded embed+rerank usage internally.
  const route = pickAgent(req.agent, req.message);
  yield { type: "context", usage: built.usage, agent: route.agent, routeReason: route.reason };

  const systemPrompt = built.systemPrompt;
  const userPrompt = req.message;

  const agentRecorder = makeRecorder(db, route.agent, story.id);

  let full = "";
  try {
    for await (const chunk of streamFor(route.agent, userPrompt, {
      systemPrompt,
      cwd: cfg.VAULT_PATH,
      onUsage: (u) => agentRecorder({
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
    const msg = e instanceof Error ? e.message : String(e);
    yield { type: "error", error: msg };
    return;
  }

  const assistant = appendMessage(db, {
    storyId: story.id,
    role: "assistant",
    agent: route.agent,
    content: full,
    contextUsed: { ...built.usage, routedAgent: route.agent, routeReason: route.reason },
  });
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
      cwd: cfg.VAULT_PATH,
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
    historyTurns: history.length,
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

  // 3. RAG retrieval — semantic lore search seeded by user message + recent assistant turn
  try {
    const last = history.slice(-2).map((m) => m.content).join("\n");
    const queryText = (last ? last + "\n" : "") + userMessage;
    const embedRec = makeRecorder(db, "voyage_embed", story.id);
    const rerankRec = makeRecorder(db, "voyage_rerank", story.id);
    const hits = await search(cfg, db, queryText, {
      mode: "lore",
      topK: LORE_HITS,
      candidates: 30,
      useRerank: true,
      onEmbedUsage: embedRec,
      onRerankUsage: rerankRec,
    });
    usage.loreHits = hits.map((h: SearchHit) => ({
      path: h.filePath,
      heading: h.headingPath,
      score: h.rerankScore ?? 1 - h.vectorDistance,
    }));
    if (hits.length > 0) {
      parts.push(`=== RELEVANT LORE (RAG retrieval, ranked) ===`);
      for (const h of hits) {
        const head = h.headingPath ? ` :: ${h.headingPath}` : "";
        const preview =
          h.content.length > STYLE_LORE_PREVIEW_CHARS
            ? h.content.slice(0, STYLE_LORE_PREVIEW_CHARS) + "…"
            : h.content;
        parts.push(`--- ${h.filePath}${head} (L${h.startLine}-${h.endLine}) ---`);
        parts.push(preview);
        parts.push("");
      }
    }
  } catch {
    /* search failure non-fatal */
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
