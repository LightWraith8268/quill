// Per-chapter beats heatmap. Score each manuscript file in a story along:
// - dialogue density (lines starting with " or ' ish)
// - action density (verbs per 100 words — heuristic)
// - emphasis density (italics + em-dash counts)
// - sentence-length variance
//
// Returns 0-1 normalized scores per file, suitable for inline rendering.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { buildReadingPass } from "./reading.ts";

const ACTION_VERBS = new Set(
  [
    "ran", "leapt", "shot", "spun", "slammed", "drew", "fired",
    "hit", "ducked", "rolled", "tackled", "dodged", "punched", "kicked",
    "screamed", "yelled", "shouted", "whispered", "growled", "roared",
    "stabbed", "lunged", "broke", "shattered", "slashed", "stumbled",
    "lurched", "ripped", "tore", "burst", "crashed", "exploded",
  ]
);

export type ChapterBeats = {
  path: string;
  title: string;
  words: number;
  dialogueDensity: number;
  actionDensity: number;
  emphasisDensity: number;
  avgSentenceLen: number;
  sentenceVariance: number;
  /** 0-1 composite intensity score */
  intensity: number;
};

function score(text: string): Omit<ChapterBeats, "path" | "title"> {
  const stripped = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  const words = (stripped.match(/\b\w+\b/g) ?? []).length;
  if (words === 0) {
    return {
      words: 0,
      dialogueDensity: 0,
      actionDensity: 0,
      emphasisDensity: 0,
      avgSentenceLen: 0,
      sentenceVariance: 0,
      intensity: 0,
    };
  }

  // Dialogue: count lines that look like dialogue
  const dlines = stripped
    .split(/\n+/)
    .filter((l) => /^\s*"|^\s*[*]?[A-Z]/.test(l) && /["]/.test(l));
  const dialogueDensity = Math.min(1, dlines.length / Math.max(1, stripped.split(/\n+/).length));

  // Action verbs in past tense — weight per 100 words
  const verbHits =
    stripped.toLowerCase().split(/\b/).filter((t) => ACTION_VERBS.has(t)).length;
  const actionDensity = Math.min(1, verbHits / (words / 100));

  // Emphasis: em-dashes + italic markers
  const emHits = (stripped.match(/—/g) ?? []).length + (stripped.match(/\*[^*\n]+\*/g) ?? []).length;
  const emphasisDensity = Math.min(1, emHits / (words / 100));

  // Sentence length stats
  const sentences = stripped
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const lengths = sentences.map((s) => s.split(/\s+/).length);
  const avgSentenceLen = lengths.length === 0 ? 0 : lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance =
    lengths.length === 0
      ? 0
      : lengths.reduce((a, b) => a + (b - avgSentenceLen) ** 2, 0) / lengths.length;

  const intensity = Math.min(
    1,
    0.4 * actionDensity +
      0.3 * dialogueDensity +
      0.2 * emphasisDensity +
      0.1 * Math.min(1, variance / 100)
  );
  return {
    words,
    dialogueDensity,
    actionDensity,
    emphasisDensity,
    avgSentenceLen,
    sentenceVariance: variance,
    intensity,
  };
}

export async function buildBeats(
  cfg: Config,
  db: DB,
  storyId: number
): Promise<{ chapters: ChapterBeats[] }> {
  const r = await buildReadingPass(cfg, db, storyId);
  const chapters: ChapterBeats[] = [];
  for (const p of r.parts) {
    chapters.push({
      path: p.path,
      title: p.title,
      ...score(p.content),
    });
  }
  return { chapters };
}

export async function loadPronunciationMap(cfg: Config): Promise<Record<string, string>> {
  const path = join(cfg.VAULT_PATH, "Reference", "pronunciation.json");
  try {
    const buf = await readFile(path, "utf-8");
    const parsed = JSON.parse(buf);
    if (parsed && typeof parsed === "object") return parsed as Record<string, string>;
  } catch {
    /* none */
  }
  return {};
}

export async function savePronunciationMap(
  cfg: Config,
  map: Record<string, string>
): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const dir = join(cfg.VAULT_PATH, "Reference");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "pronunciation.json"),
    JSON.stringify(map, null, 2),
    "utf-8"
  );
}
