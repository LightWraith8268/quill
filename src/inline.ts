// Inline editor AI: rewrite selected text, or continue from cursor.
// Lightweight pass-through to Claude; no chat history, no RAG cost. Fast.

import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { claudeStream, claudeOnce } from "./agents/claude.ts";
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

export type InlineGhostRequest = {
  storyId?: number;
  precedingText: string;
  /** >0 asks for an alternate continuation than the obvious one. */
  variant?: number;
};

// Cheap, no-LLM canon grounding for ghost text: direct entity-name match on the
// tail of the prose → that entity's top hard/soft-canon claims. Keeps ambient
// completion grounded without paying an embed/RAG cost on every pause.
function canonHint(db: DB, series: string | null, tail: string): string {
  if (!series) return "";
  const rows = db
    .query<{ name: string; claim: string }, [string | null, string | null]>(
      `SELECT e.name AS name, f.claim AS claim
       FROM kb_facts f JOIN kb_entities e ON e.id = f.entity_id
       WHERE (f.series IS ? OR f.series = ?)
         AND f.canon_weight IN ('hard_canon','soft_canon')
       ORDER BY CASE f.canon_weight WHEN 'hard_canon' THEN 0 ELSE 1 END, f.id DESC
       LIMIT 300`
    )
    .all(series, series);
  const low = tail.toLowerCase();
  const seen = new Set<string>();
  const hits: string[] = [];
  for (const r of rows) {
    if (!r.name) continue;
    const nm = r.name.toLowerCase();
    if (nm.length < 3 || seen.has(nm)) continue;
    if (low.includes(nm)) {
      hits.push(`- ${r.name}: ${r.claim}`);
      seen.add(nm);
      if (hits.length >= 3) break;
    }
  }
  return hits.length ? `=== CANON (respect; do not contradict) ===\n${hits.join("\n")}\n\n` : "";
}

export async function buildStylePrefix(cfg: Config, db: DB, storyId?: number): Promise<string> {
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

// Ambient ghost completion: a short, canon-aware continuation returned whole
// (not streamed) for an inline gray suggestion. Tuned for low latency — Sonnet
// via CLAUDE_MODEL + skipMcp, no chat history, no RAG.
export async function inlineGhost(
  cfg: Config,
  db: DB,
  req: InlineGhostRequest
): Promise<{ text: string; model: string | null }> {
  const story = req.storyId ? getStory(db, req.storyId) : null;
  const stylePrefix = await buildStylePrefix(cfg, db, req.storyId);
  const hint = story ? canonHint(db, story.series, req.precedingText.slice(-400)) : "";
  const variantNudge =
    req.variant && req.variant > 0
      ? " Give a DIFFERENT continuation than the most obvious one."
      : "";

  const systemPrompt =
    SYSTEM_HEADER +
    "\n\n" +
    stylePrefix +
    hint +
    `TASK: continue the prose at the cursor with a SHORT completion — finish the current sentence, or add at most one short sentence (~25 words max). Match voice, tense, and POV exactly. Output ONLY the new text to append after the cursor: no quotes, no metadata, and do NOT repeat any existing words.${variantNudge}`;

  const userPrompt = `PRECEDING TEXT (continuation appends directly after this):\n${req.precedingText.slice(-1500)}`;

  const recorder = makeRecorder(db, "claude", req.storyId ?? null);
  let model: string | null = null;
  const text = await claudeOnce(userPrompt, {
    systemPrompt,
    cwd: cfg.VAULT_PATH,
    skipMcp: true,
    onUsage: (u) => {
      model = u.model ?? model;
      recorder({
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cachedInputTokens: u.cachedInputTokens,
        model: u.model,
      });
    },
  });
  return { text: cleanGhost(text), model };
}

// Strip wrapping quotes/whitespace the model sometimes adds despite instructions.
function cleanGhost(s: string): string {
  let t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1);
  }
  return t.trim();
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
