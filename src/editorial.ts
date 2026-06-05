// Editorial passes: one-click targeted revisions over a whole file or a
// selection. Each pass rewrites the text with a single editorial intent
// (tighten, dialogue, sensory, pacing, line-edit) and returns the FULL revised
// text so the client can diff it and let the writer accept/reject per hunk.

import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { claudeOnce } from "./agents/claude.ts";
import { buildStylePrefix } from "./inline.ts";
import { makeRecorder } from "./usage.ts";

export const EDITORIAL_PASSES = {
  tighten: {
    label: "Tighten",
    blurb: "Cut filler, redundancy, weak qualifiers",
    instruction:
      "Tighten the prose: cut filler words, redundancy, hedges, and weak qualifiers; prefer strong verbs. Preserve meaning, plot, voice, POV, tense, and ALL dialogue content. Keep paragraph structure.",
  },
  dialogue: {
    label: "Punch up dialogue",
    blurb: "Sharper lines, distinct voices, subtext",
    instruction:
      "Sharpen the dialogue: make each speaker's voice more distinct, cut on-the-nose lines, add subtext and rhythm. Leave narration/description essentially unchanged. Do not change who says what or the plot.",
  },
  sensory: {
    label: "Add sensory detail",
    blurb: "Ground thin scenes in the senses",
    instruction:
      "Add concrete, specific sensory detail (sight, sound, smell, touch, taste) where scenes feel thin or abstract. Enhance, don't pad — keep it economical and in-voice. Preserve plot, dialogue, and pacing.",
  },
  pacing: {
    label: "Fix pacing",
    blurb: "Vary rhythm, trim slow, expand rushed",
    instruction:
      "Improve pacing: vary sentence length and rhythm, break or merge paragraphs as needed, trim slow stretches, and give rushed beats room to land. Preserve all story content and voice.",
  },
  line: {
    label: "Line edit",
    blurb: "Grammar, word choice, clarity, rhythm",
    instruction:
      "Line-edit conservatively: fix grammar, awkward phrasing, word choice, and clarity while preserving the author's voice and intent. Do not rewrite wholesale or change story content.",
  },
} as const;

export type EditorialPass = keyof typeof EDITORIAL_PASSES;

export function isEditorialPass(s: string): s is EditorialPass {
  return Object.prototype.hasOwnProperty.call(EDITORIAL_PASSES, s);
}

export type EditorialRequest = {
  storyId?: number;
  text: string;
  pass: EditorialPass;
};

export async function editorialPass(
  cfg: Config,
  db: DB,
  req: EditorialRequest
): Promise<{ revised: string; pass: EditorialPass; model: string | null }> {
  const def = EDITORIAL_PASSES[req.pass];
  const stylePrefix = await buildStylePrefix(cfg, db, req.storyId);

  const systemPrompt =
    "You are a meticulous line editor working inside a markdown editor. " +
    "Apply EXACTLY ONE editorial pass to the manuscript text and return the " +
    "ENTIRE revised text — every paragraph, in order, including the parts you " +
    "left unchanged. Output prose ONLY: no commentary, no preamble, no markdown " +
    "code fences, no diff markers.\n\n" +
    stylePrefix +
    `PASS: ${def.instruction}\n\n` +
    "Make only the changes this pass calls for. Leave everything else byte-for-byte identical so a diff is small and reviewable.";

  const userPrompt = `MANUSCRIPT TEXT:\n${req.text}`;

  const recorder = makeRecorder(db, "claude", req.storyId ?? null);
  let model: string | null = null;
  const revised = await claudeOnce(userPrompt, {
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

  return { revised: stripFences(revised), pass: req.pass, model };
}

// The model occasionally wraps output in a ```...``` block despite instructions.
function stripFences(s: string): string {
  const t = s.trim();
  const m = t.match(/^```(?:\w+)?\s*\n([\s\S]*?)\n```$/);
  return m ? m[1]! : t;
}
