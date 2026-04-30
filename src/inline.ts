// Inline editor AI: rewrite selected text, or continue from cursor.
// Lightweight pass-through to Claude; no chat history, no RAG cost. Fast.

import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { claudeStream } from "./agents/claude.ts";
import { composeStyle } from "./style.ts";
import { getStory } from "./stories.ts";
import { makeRecorder } from "./usage.ts";

const SYSTEM_HEADER =
  "You are an inline writing copilot embedded in a markdown editor. Output prose ONLY — no preamble, no commentary, no explanation. Match the user's voice and the active style profile if given.";

export type InlineEditRequest = {
  storyId?: number;
  selection: string;
  instruction: string;
};

export type InlineContinueRequest = {
  storyId?: number;
  precedingText: string;
  /** Hint for length cap: "sentence" | "paragraph" | "scene". Default "paragraph". */
  length?: "sentence" | "paragraph" | "scene";
};

async function buildStylePrefix(cfg: Config, db: DB, storyId?: number): Promise<string> {
  if (!storyId) return "";
  const story = getStory(db, storyId);
  if (!story?.active_style) return "";
  try {
    const composed = await composeStyle(cfg, story.active_style, story.active_genres);
    if (!composed) return "";
    return `=== ACTIVE STYLE PROFILE ===\n${composed.content}\n\n`;
  } catch {
    return "";
  }
}

export async function* inlineEditStream(
  cfg: Config,
  db: DB,
  req: InlineEditRequest
): AsyncGenerator<string, void, void> {
  const stylePrefix = await buildStylePrefix(cfg, db, req.storyId);
  const systemPrompt =
    SYSTEM_HEADER +
    "\n\n" +
    stylePrefix +
    "TASK: rewrite the SELECTION below per the INSTRUCTION. Return ONLY the rewritten prose, no quotes, no metadata, no apology, no explanation. Length should match the selection unless the instruction says otherwise. Match all anti-patterns from the active style profile.";

  const userPrompt = [
    `INSTRUCTION: ${req.instruction}`,
    ``,
    `SELECTION:`,
    req.selection,
  ].join("\n");

  const recorder = makeRecorder(db, "claude", req.storyId ?? null);
  for await (const chunk of claudeStream(userPrompt, {
    systemPrompt,
    cwd: cfg.VAULT_PATH,
    onUsage: (u) =>
      recorder({
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cachedInputTokens: u.cachedInputTokens,
        model: u.model,
      }),
  })) {
    yield chunk;
  }
}

export async function* inlineContinueStream(
  cfg: Config,
  db: DB,
  req: InlineContinueRequest
): AsyncGenerator<string, void, void> {
  const stylePrefix = await buildStylePrefix(cfg, db, req.storyId);
  const lengthHint =
    req.length === "sentence"
      ? "Continue with ONE sentence."
      : req.length === "scene"
      ? "Continue with up to 5 paragraphs."
      : "Continue with ONE paragraph.";

  const systemPrompt =
    SYSTEM_HEADER +
    "\n\n" +
    stylePrefix +
    `TASK: continue the prose below at the cursor. ${lengthHint} Match voice, tense, POV, and active style profile rigorously. Output ONLY the new prose — do NOT repeat the existing text, do NOT prefix with quotes or metadata. Begin where the user stopped.`;

  const userPrompt = [`PRECEDING TEXT (your continuation goes after this):`, req.precedingText].join("\n");

  const recorder = makeRecorder(db, "claude", req.storyId ?? null);
  for await (const chunk of claudeStream(userPrompt, {
    systemPrompt,
    cwd: cfg.VAULT_PATH,
    onUsage: (u) =>
      recorder({
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cachedInputTokens: u.cachedInputTokens,
        model: u.model,
      }),
  })) {
    yield chunk;
  }
}
