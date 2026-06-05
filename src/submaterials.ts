// Submission materials, drawn from canon. Generates the pitch documents an
// author needs to query agents — logline, back-cover blurb, synopsis, and a
// query letter — grounded in the story's canon graph and outline so they stay
// faithful to the actual book (including its ending) rather than hallucinating.

import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { getStory } from "./stories.ts";
import { listGraph } from "./knowledge/store.ts";
import { listOutline } from "./outline.ts";
import { claudeOnce } from "./agents/claude.ts";
import { makeRecorder } from "./usage.ts";

export const MATERIAL_KINDS = {
  logline: {
    label: "Logline",
    blurb: "One-sentence hook",
    instruction:
      "Write a single-sentence logline: protagonist + goal + central conflict + stakes. Punchy, specific, no title drop.",
  },
  blurb: {
    label: "Back-cover blurb",
    blurb: "~150-word jacket copy",
    instruction:
      "Write back-cover/jacket copy of about 120-160 words: hook the reader, introduce the protagonist and the central conflict, raise the stakes, end on a question or tease. Do NOT reveal the ending. Marketing voice, in genre.",
  },
  synopsis: {
    label: "Synopsis",
    blurb: "Full plot incl. ending",
    instruction:
      "Write a 1-2 page synopsis in present tense covering the COMPLETE plot arc including the ending and key turns. Name the main characters in caps on first mention. This is for an agent — be complete and spoiler-full, not teasing.",
  },
  query: {
    label: "Query letter",
    blurb: "Agent query (hook + meta)",
    instruction:
      "Write a query letter to a literary agent: a strong hook paragraph, a short stakes/conflict paragraph, then a metadata line (genre, approximate word count if known, 1-2 comparable titles if you can infer them). Leave a [bio placeholder] for the author bio. Professional, confident, no gimmicks.",
  },
} as const;

export type MaterialKind = keyof typeof MATERIAL_KINDS;

export function isMaterialKind(s: string): s is MaterialKind {
  return Object.prototype.hasOwnProperty.call(MATERIAL_KINDS, s);
}

function buildCanonBasis(db: DB, storyId: number, series: string | null): string {
  const parts: string[] = [];

  // Characters + key entities.
  const graph = listGraph(db, series);
  const chars = graph.entities.filter((e) => e.kind === "character").slice(0, 12);
  if (chars.length) {
    parts.push(`CHARACTERS: ${chars.map((c) => c.name).join(", ")}`);
  }

  // Top canon facts (authoritative first) — the story's spine.
  const facts = db
    .query<{ name: string | null; claim: string; w: string }, [string | null, string | null]>(
      `SELECT e.name AS name, f.claim AS claim, f.canon_weight AS w
       FROM kb_facts f LEFT JOIN kb_entities e ON e.id = f.entity_id
       WHERE (f.series IS ? OR f.series = ?)
         AND f.canon_weight IN ('hard_canon','soft_canon','outline_plan')
       ORDER BY CASE f.canon_weight WHEN 'hard_canon' THEN 0 WHEN 'soft_canon' THEN 1 ELSE 2 END, f.id
       LIMIT 60`
    )
    .all(series, series);
  if (facts.length) {
    parts.push(
      `KEY CANON:\n${facts.map((f) => `- ${f.name ? `${f.name}: ` : ""}${f.claim}`).join("\n")}`
    );
  }

  // Outline = the plot skeleton (titles + summaries, in order).
  const nodes = listOutline(db, storyId);
  const beats = nodes
    .filter((n) => n.kind !== "note" && (n.summary || n.title))
    .map((n) => `- [${n.kind}] ${n.title}${n.summary ? `: ${n.summary}` : ""}`);
  if (beats.length) {
    parts.push(`PLOT OUTLINE (in order):\n${beats.join("\n").slice(0, 8000)}`);
  }

  return parts.join("\n\n");
}

export async function generateMaterial(
  cfg: Config,
  db: DB,
  storyId: number,
  kind: MaterialKind
): Promise<{ kind: MaterialKind; text: string; model: string | null }> {
  const story = getStory(db, storyId);
  if (!story) throw new Error(`story ${storyId} not found`);

  const basis = buildCanonBasis(db, storyId, story.series);
  const def = MATERIAL_KINDS[kind];

  const systemPrompt =
    "You are a publishing-savvy author's assistant writing submission materials. " +
    "Base everything ONLY on the canon and outline provided — do not invent plot, characters, or events that aren't supported. " +
    "If the material is thin, work with what's given and keep claims general rather than fabricating specifics. " +
    "Output ONLY the requested document: no headers like 'Here is…', no commentary, no markdown fences.\n\n" +
    `TASK: ${def.instruction}`;

  const userPrompt = `STORY: ${story.name}${story.series ? ` (series: ${story.series})` : ""}\n\n=== CANON & OUTLINE ===\n${basis || "(no canon extracted yet — infer cautiously from the title only)"}`;

  const recorder = makeRecorder(db, "claude", storyId);
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

  return { kind, text: text.trim(), model };
}
