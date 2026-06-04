// Story-structure analysis: beat-sheet alignment (LLM classifies the manuscript
// against a structure template) and pacing outlier detection (chapters whose
// word count deviates >1.5σ from the mean).

import type { Config } from "../config.ts";
import type { DB } from "../db.ts";
import { claudeOnce } from "../agents/claude.ts";
import { buildReadingPass } from "../reading.ts";

export const BEAT_TEMPLATES: Record<string, { name: string; beats: string[] }> = {
  "save-the-cat": {
    name: "Save the Cat",
    beats: [
      "Opening Image",
      "Theme Stated",
      "Setup",
      "Catalyst",
      "Debate",
      "Break into Two",
      "B Story",
      "Fun and Games",
      "Midpoint",
      "Bad Guys Close In",
      "All Is Lost",
      "Dark Night of the Soul",
      "Break into Three",
      "Finale",
      "Final Image",
    ],
  },
  "hero-journey": {
    name: "Hero's Journey",
    beats: [
      "Ordinary World",
      "Call to Adventure",
      "Refusal of the Call",
      "Meeting the Mentor",
      "Crossing the Threshold",
      "Tests, Allies, Enemies",
      "Approach to the Inmost Cave",
      "Ordeal",
      "Reward",
      "The Road Back",
      "Resurrection",
      "Return with the Elixir",
    ],
  },
  "three-act": {
    name: "Three-Act",
    beats: [
      "Hook",
      "Inciting Incident",
      "Plot Point 1",
      "Rising Action",
      "Midpoint",
      "Pinch Point",
      "Plot Point 2",
      "Climax",
      "Resolution",
    ],
  },
};

export type BeatStatus = "present" | "weak" | "missing";
export type BeatResult = { beat: string; status: BeatStatus; chapter: string | null; note: string };
export type BeatAlignment = { template: string; coverage: number; beats: BeatResult[] };

const BEAT_SYS = `You assess how well a manuscript hits a story-structure beat sheet. For each beat, decide if it is "present", "weak", or "missing" in the chapter outline, name the chapter it best maps to (or null), and add a one-line note. Output STRICT JSON only:
{ "beats": [ { "beat": "<beat name>", "status": "present|weak|missing", "chapter": "<chapter title or null>", "note": "<short>" } ] }`;

export async function alignBeats(
  cfg: Config,
  db: DB,
  storyId: number,
  templateId: string
): Promise<BeatAlignment> {
  const tpl = BEAT_TEMPLATES[templateId];
  if (!tpl) throw new Error(`unknown template: ${templateId} (have ${Object.keys(BEAT_TEMPLATES).join(", ")})`);

  const r = await buildReadingPass(cfg, db, storyId);
  const outline = r.parts
    .map((p, i) => `Chapter ${i + 1} — ${p.title}: ${p.content.replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n");

  const prompt = `${BEAT_SYS}\n\n=== BEAT SHEET: ${tpl.name} ===\n${tpl.beats
    .map((b) => `- ${b}`)
    .join("\n")}\n\n=== CHAPTER OUTLINE ===\n${outline.slice(0, 80_000)}`;

  const out = await claudeOnce(prompt, { cwd: cfg.VAULT_PATH });
  let t = out.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) t = fence[1].trim();
  if (!t.startsWith("{")) {
    const i = t.indexOf("{");
    const j = t.lastIndexOf("}");
    if (i >= 0 && j > i) t = t.slice(i, j + 1);
  }

  let beats: BeatResult[] = tpl.beats.map((b) => ({
    beat: b,
    status: "missing" as BeatStatus,
    chapter: null,
    note: "",
  }));
  try {
    const parsed = JSON.parse(t) as {
      beats?: Array<{ beat?: string; status?: string; chapter?: string | null; note?: string }>;
    };
    const byName = new Map(beats.map((b) => [b.beat.toLowerCase(), b]));
    for (const x of parsed.beats ?? []) {
      const slot = byName.get(String(x.beat ?? "").toLowerCase());
      if (!slot) continue;
      slot.status =
        x.status === "present" || x.status === "weak" ? x.status : "missing";
      slot.chapter = x.chapter ?? null;
      slot.note = String(x.note ?? "");
    }
  } catch {
    /* keep all-missing fallback */
  }

  const coverage =
    beats.reduce((s, b) => s + (b.status === "present" ? 1 : b.status === "weak" ? 0.5 : 0), 0) /
    beats.length;
  return { template: tpl.name, coverage: Math.round(coverage * 100) / 100, beats };
}

export type PacingChapter = {
  title: string;
  path: string;
  words: number;
  z: number;
  outlier: boolean;
};
export type PacingReport = {
  mean: number;
  stdev: number;
  chapters: PacingChapter[];
  outliers: string[];
};

// Pure: flag chapters whose word count is >1.5σ from the mean.
export function computePacing(
  items: { title: string; path: string; words: number }[],
  sigma = 1.5
): PacingReport {
  const n = items.length;
  if (n === 0) return { mean: 0, stdev: 0, chapters: [], outliers: [] };
  const mean = items.reduce((s, c) => s + c.words, 0) / n;
  const variance = items.reduce((s, c) => s + (c.words - mean) ** 2, 0) / n;
  const stdev = Math.sqrt(variance);
  const chapters: PacingChapter[] = items.map((c) => {
    const z = stdev > 0 ? (c.words - mean) / stdev : 0;
    return { ...c, z: Math.round(z * 100) / 100, outlier: Math.abs(z) > sigma };
  });
  return {
    mean: Math.round(mean),
    stdev: Math.round(stdev),
    chapters,
    outliers: chapters.filter((c) => c.outlier).map((c) => c.title),
  };
}

export async function pacingReport(cfg: Config, db: DB, storyId: number): Promise<PacingReport> {
  const r = await buildReadingPass(cfg, db, storyId);
  const items = r.parts.map((p) => ({
    title: p.title,
    path: p.path,
    words: (p.content.match(/\b\w+\b/g) ?? []).length,
  }));
  return computePacing(items);
}
