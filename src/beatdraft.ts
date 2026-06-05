// "Draft this beat": turn one outline node into a generation surface. Assembles
// the full context pack — beat intent (title + summary), the active style
// profile, in-scope canon (facts + manuscript matches for the beat), and the
// previous scene's ending for continuity — then streams a drafted scene.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { getStory } from "./stories.ts";
import { listOutline } from "./outline.ts";
import { composeStyle } from "./style.ts";
import { retrieveCanon } from "./knowledge/retrieve.ts";
import { renderCanonPack } from "./knowledge/contextpack.ts";
import { claudeStream } from "./agents/claude.ts";
import { storyCwd } from "./workspace.ts";
import { makeRecorder } from "./usage.ts";

const PRIOR_ENDING_CHARS = 1000;

export async function* draftBeatStream(
  cfg: Config,
  db: DB,
  storyId: number,
  nodeId: number
): AsyncGenerator<string, void, void> {
  const story = getStory(db, storyId);
  if (!story) throw new Error(`story ${storyId} not found`);
  const nodes = listOutline(db, storyId);
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`outline node ${nodeId} not found`);

  const parts: string[] = [
    "You are an expert novelist drafting ONE scene from an outline beat. Write immersive, publishable prose that realizes the beat below. Output prose ONLY — markdown paragraphs, no scene headers, no commentary, no notes, no code fences. Continue seamlessly from the prior scene's ending if one is given (do not repeat it).",
    "",
  ];

  // Active style profile.
  if (story.active_style) {
    try {
      const composed = await composeStyle(cfg, story.active_style, story.active_genres);
      if (composed) {
        parts.push("=== ACTIVE STYLE PROFILE ===", composed.content, "");
      }
    } catch {
      /* style optional */
    }
  }

  // In-scope canon for this beat (facts ranked by weight + manuscript matches).
  try {
    const query = `${node.title}\n${node.summary ?? ""}`.trim();
    if (query) {
      const embedRec = makeRecorder(db, "voyage_embed", storyId);
      const rerankRec = makeRecorder(db, "voyage_rerank", storyId);
      const items = await retrieveCanon(cfg, db, query, {
        scope: { series: story.series, book: story.name },
        factK: 10,
        chunkK: 4,
        useRerank: true,
        onEmbedUsage: embedRec,
        onRerankUsage: rerankRec,
      });
      const chunks = items.filter((i) => i.kind === "chunk");
      const facts = items.filter((i) => i.kind !== "chunk");
      const pack = renderCanonPack(facts, chunks, { previewChars: 500 });
      if (pack) parts.push(pack, "");
    }
  } catch {
    /* retrieval optional */
  }

  // Prior scene's ending — the nearest earlier node with a manuscript file.
  const idx = nodes.indexOf(node);
  for (let i = idx - 1; i >= 0; i--) {
    const prev = nodes[i]!;
    if (!prev.manuscript_path) continue;
    try {
      const content = await readFile(join(cfg.VAULT_PATH, prev.manuscript_path), "utf-8");
      const ending = content.trimEnd().slice(-PRIOR_ENDING_CHARS);
      if (ending) {
        parts.push(
          `=== PRIOR SCENE ENDING (${prev.title} — continue AFTER this, do not repeat it) ===`,
          ending,
          ""
        );
      }
    } catch {
      /* file may be missing */
    }
    break;
  }

  const target = node.target_words ?? 800;
  parts.push(
    "=== INSTRUCTIONS ===",
    `Draft this beat as a complete scene of roughly ${target} words. Honor the style profile and stay consistent with the canon above. Show, don't summarize. Match the established voice, tense, and POV.`
  );

  const systemPrompt = parts.join("\n");
  const userPrompt = [
    `BEAT TO DRAFT`,
    `Title: ${node.title}`,
    node.summary ? `Intent: ${node.summary}` : `Intent: (none given — infer from the title and canon)`,
    `Target length: ~${target} words.`,
  ].join("\n");

  const recorder = makeRecorder(db, "claude", storyId);
  for await (const chunk of claudeStream(userPrompt, {
    systemPrompt,
    cwd: storyCwd(cfg, story),
    skipMcp: true,
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
