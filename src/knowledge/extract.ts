// On-demand knowledge extraction: read a book's bibles + manuscript, ask the
// LLM for a typed entity/relationship/canon graph, upsert into the kb_ tables.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { DB } from "../db.ts";
import { claudeOnce } from "../agents/claude.ts";
import { getStory } from "../stories.ts";
import {
  CANON_WEIGHTS,
  ENTITY_KINDS,
  type CanonWeight,
  type EntityKind,
  type ScopeType,
} from "./models.ts";
import { addEdge, addFact, upsertEntity } from "./store.ts";

export type ExtractInput = {
  series: string | null;
  book?: string | null;
  sources: { path: string; content: string }[];
};

export type ExtractResult = {
  entities: number;
  facts: number;
  relationships: number;
  model: string | null;
};

type RawEntity = {
  kind?: string;
  name?: string;
  aliases?: string[];
  tags?: string[];
  facts?: { claim?: string; canon_weight?: string; scope?: string; source_ref?: string }[];
};
type RawRel = { from?: string; to?: string; type?: string; description?: string; directed?: boolean };
type RawOut = { entities?: RawEntity[]; relationships?: RawRel[] };

const ENTITY_KIND_SET = new Set<string>(ENTITY_KINDS);
const CANON_SET = new Set<string>(CANON_WEIGHTS);
const SCOPE_SET = new Set<string>(["global", "series", "book", "chapter", "scene"]);

export function coerceKind(k?: string): EntityKind {
  const v = (k ?? "").toLowerCase().replace(/\s+/g, "_");
  return (ENTITY_KIND_SET.has(v) ? v : "character") as EntityKind;
}
export function coerceWeight(w?: string): CanonWeight {
  const v = (w ?? "").toLowerCase().replace(/\s+/g, "_");
  return (CANON_SET.has(v) ? v : "soft_canon") as CanonWeight;
}
export function coerceScope(s?: string): ScopeType {
  const v = (s ?? "").toLowerCase();
  return (SCOPE_SET.has(v) ? v : "series") as ScopeType;
}

export function parseJsonLoose<T = unknown>(text: string): T | null {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) t = fence[1].trim();
  if (!t.startsWith("{")) {
    const i = t.indexOf("{");
    const j = t.lastIndexOf("}");
    if (i >= 0 && j > i) t = t.slice(i, j + 1);
  }
  try {
    return JSON.parse(t) as T;
  } catch {
    return null;
  }
}

const SYS = `You extract a story's canon knowledge graph from the provided text. Output STRICT JSON only — no prose, no markdown fences.

Schema:
{
  "entities": [
    {
      "kind": "character|location|faction|magic|tech|artifact|species|event|rule|prophecy|glossary_term|world",
      "name": "canonical name",
      "aliases": ["other names the text uses"],
      "tags": ["short descriptive tags"],
      "facts": [
        { "claim": "one concrete fact about this entity", "canon_weight": "hard_canon|soft_canon|outline_plan|draft_text|note", "scope": "series|book", "source_ref": "where in the text" }
      ]
    }
  ],
  "relationships": [
    { "from": "entity name", "to": "entity name", "type": "ally|enemy|parent|sibling|mentor|member-of|located-in|owns", "description": "short", "directed": true }
  ]
}

Rules:
- Use "hard_canon" only for explicit, authoritative bible/reference facts; use "draft_text" for things only implied by manuscript prose.
- Prefer a few high-value facts over many trivial ones.
- "from"/"to" in relationships MUST match an entity "name" you listed.`;

export async function extractBook(
  cfg: Config,
  db: DB,
  input: ExtractInput
): Promise<ExtractResult> {
  const corpus = input.sources
    .map((s) => `=== SOURCE: ${s.path} ===\n${s.content}`)
    .join("\n\n")
    .slice(0, 120_000);

  const prompt = `${SYS}\n\n=== STORY TEXT (series: ${input.series ?? "?"}${
    input.book ? `, book: ${input.book}` : ""
  }) ===\n${corpus}`;

  let model: string | null = null;
  const text = await claudeOnce(prompt, {
    cwd: cfg.VAULT_PATH,
    skipMcp: true,
    model: cfg.CLAUDE_FAST_MODEL || undefined,
    onUsage: (u) => {
      model = u.model ?? model;
    },
  });

  const parsed = parseJsonLoose<RawOut>(text);
  if (!parsed) throw new Error("extraction returned unparseable JSON");

  const ents = Array.isArray(parsed.entities) ? parsed.entities : [];
  const nameToId = new Map<string, number>();
  let nFacts = 0;
  let nRel = 0;

  const tx = db.transaction(() => {
    for (const re of ents) {
      if (!re.name) continue;
      const ent = upsertEntity(db, {
        series: input.series,
        kind: coerceKind(re.kind),
        name: re.name,
        aliases: re.aliases?.filter(Boolean),
        tags: re.tags?.filter(Boolean),
      });
      nameToId.set(re.name.trim().toLowerCase(), ent.id);
      for (const a of re.aliases ?? []) nameToId.set(a.trim().toLowerCase(), ent.id);
      for (const f of re.facts ?? []) {
        if (!f.claim) continue;
        addFact(db, {
          entityId: ent.id,
          series: input.series,
          book: input.book ?? null,
          scope: coerceScope(f.scope),
          canonWeight: coerceWeight(f.canon_weight),
          claim: f.claim,
          sourceRef: f.source_ref ?? null,
          actor: "llm-extract",
        });
        nFacts++;
      }
    }
    for (const rel of Array.isArray(parsed.relationships) ? parsed.relationships : []) {
      if (!rel.from || !rel.to || !rel.type) continue;
      const src = nameToId.get(rel.from.trim().toLowerCase());
      const dst = nameToId.get(rel.to.trim().toLowerCase());
      if (src == null || dst == null) continue;
      addEdge(db, {
        srcEntityId: src,
        dstEntityId: dst,
        relType: rel.type,
        directed: rel.directed !== false,
        description: rel.description ?? null,
        series: input.series,
      });
      nRel++;
    }
  });
  tx();

  return { entities: ents.length, facts: nFacts, relationships: nRel, model };
}

const SERIES_BIBLES = [
  "CHARACTER_BIBLE.md",
  "World Bible v2.md",
  "CANON_REFERENCE_SUMMARY.md",
  "SYSTEM_RULES_TABLE.md",
  "TIMELINE_SCENE_GRID.md",
];

async function gatherStorySources(
  cfg: Config,
  story: { path: string; series: string | null; name: string }
): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  if (story.series) {
    for (const f of SERIES_BIBLES) {
      const rel = `Books/${story.series}/${f}`;
      try {
        out.push({ path: rel, content: await readFile(join(cfg.VAULT_PATH, rel), "utf-8") });
      } catch {
        /* bible may not exist */
      }
    }
  }
  try {
    const abs = join(cfg.VAULT_PATH, story.path);
    const entries = await readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) {
        try {
          out.push({
            path: `${story.path}/${e.name}`,
            content: await readFile(join(abs, e.name), "utf-8"),
          });
        } catch {
          /* skip */
        }
      }
    }
  } catch {
    /* story folder may be missing */
  }
  return out;
}

export async function extractStory(cfg: Config, db: DB, storyId: number): Promise<ExtractResult> {
  const story = getStory(db, storyId);
  if (!story) throw new Error(`story ${storyId} not found`);
  const sources = await gatherStorySources(cfg, story);
  if (sources.length === 0) throw new Error(`no source files found for story ${storyId}`);
  return extractBook(cfg, db, { series: story.series, book: story.name, sources });
}
