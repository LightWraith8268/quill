// "Ask your story": natural-language Q&A over a story's whole corpus + canon
// graph. Retrieves generously (facts ranked by canon weight + manuscript
// matches), then answers the question grounded ONLY in what was retrieved, with
// source citations. Streams the answer; emits the sources it used up front.

import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { getStory } from "./stories.ts";
import { retrieveCanon } from "./knowledge/retrieve.ts";
import { renderCanonPack } from "./knowledge/contextpack.ts";
import { claudeStream } from "./agents/claude.ts";
import { makeRecorder } from "./usage.ts";

export type AskSource = { path: string; ref: string | null; score: number; kind: string };

export type AskEvent =
  | { type: "sources"; sources: AskSource[] }
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; error: string };

const ASK_SYS = `You answer questions ABOUT a novel-in-progress for its author, using only the retrieved canon facts and manuscript passages provided. Rules:
- Ground every claim in the provided material. Cite the source path in brackets, e.g. [Books/Series/Book/ch3.md], when you rely on a passage or fact.
- If the material doesn't contain the answer, say so plainly — do not invent. Suggest where the author might look or what's missing.
- For "where did I…" / "every scene with…" questions, list the specific passages with their paths.
- For contradiction questions, quote the conflicting statements and their sources.
- Be concrete and concise. This is the author's own work — no spoiler warnings, no disclaimers.`;

export async function* askStoryStream(
  cfg: Config,
  db: DB,
  storyId: number,
  question: string
): AsyncGenerator<AskEvent, void, void> {
  const story = getStory(db, storyId);
  if (!story) {
    yield { type: "error", error: `story ${storyId} not found` };
    return;
  }

  let pack = "";
  let sources: AskSource[] = [];
  try {
    const items = await retrieveCanon(cfg, db, question, {
      scope: { series: story.series, book: story.name },
      factK: 14,
      chunkK: 12,
      useRerank: true,
      onEmbedUsage: makeRecorder(db, "voyage_embed", storyId),
      onRerankUsage: makeRecorder(db, "voyage_rerank", storyId),
    });
    const chunks = items.filter((i) => i.kind === "chunk");
    const facts = items.filter((i) => i.kind !== "chunk");
    pack = renderCanonPack(facts, chunks, { previewChars: 900 }) ?? "";
    sources = items
      .filter((i) => i.sourcePath)
      .map((i) => ({
        path: i.sourcePath as string,
        ref: i.sourceRef ?? null,
        score: i.score,
        kind: i.kind,
      }));
  } catch (e) {
    yield { type: "error", error: e instanceof Error ? e.message : String(e) };
    return;
  }

  yield { type: "sources", sources };

  const systemPrompt = `${ASK_SYS}

Active story: ${story.name}${story.series ? ` (series: ${story.series})` : ""}

=== RETRIEVED MATERIAL ===
${pack || "(nothing retrieved — the index may be empty for this scope)"}`;

  const recorder = makeRecorder(db, "claude", storyId);
  try {
    for await (const chunk of claudeStream(`QUESTION: ${question}`, {
      systemPrompt,
      cwd: cfg.VAULT_PATH,
      skipMcp: true,
      model: cfg.CLAUDE_FAST_MODEL || undefined,
      onUsage: (u) =>
        recorder({
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cachedInputTokens: u.cachedInputTokens,
          model: u.model,
        }),
    })) {
      if (typeof chunk === "string") yield { type: "delta", text: chunk };
    }
    yield { type: "done" };
  } catch (e) {
    yield { type: "error", error: e instanceof Error ? e.message : String(e) };
  }
}
