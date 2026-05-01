// Aggregate a glossary for a story / series:
// - lexicon entries from active style profile (base + active genres)
// - wikilink targets that appear ≥2 times in the series' files
// - frontmatter `aliases` from any file under the series

import { readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { getStory } from "./stories.ts";
import { composeStyle } from "./style.ts";
import { scanEntities } from "./vault.ts";

export type GlossaryEntry = {
  term: string;
  source: "style-lexicon" | "wikilink" | "alias";
  count?: number;
  files?: string[];
};

export type GlossaryReport = {
  story: { id: number; name: string; series: string | null };
  entries: GlossaryEntry[];
};

function extractLexiconFromComposed(content: string): string[] {
  // Pull strings from `"lexicon": [ ... ]` and `"lexicon_palette": [ ... ]`
  const out = new Set<string>();
  const re = /"lexicon(?:_palette)?"\s*:\s*\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const arr = m[1] ?? "";
    const items = arr.match(/"([^"]+)"/g) ?? [];
    for (const it of items) out.add(it.slice(1, -1));
  }
  return [...out];
}

export async function buildGlossary(
  cfg: Config,
  db: DB,
  storyId: number
): Promise<GlossaryReport> {
  const story = getStory(db, storyId);
  if (!story) throw new Error("story not found");

  const entries: GlossaryEntry[] = [];

  // 1. Style lexicon
  if (story.active_style) {
    try {
      const composed = await composeStyle(cfg, story.active_style, story.active_genres);
      if (composed) {
        for (const term of extractLexiconFromComposed(composed.content)) {
          entries.push({ term, source: "style-lexicon" });
        }
      }
    } catch {
      /* skip */
    }
  }

  // 2. Wikilinks ≥ 2 occurrences in series files
  if (story.series) {
    const allEntities = await scanEntities(cfg);
    const prefix = `Books/${story.series}/`;
    for (const e of allEntities) {
      const seriesFiles = e.files.filter((f) => f.path.startsWith(prefix));
      if (seriesFiles.length === 0) continue;
      const total = seriesFiles.reduce((s, f) => s + f.count, 0);
      if (total < 2) continue;
      entries.push({
        term: e.name,
        source: "wikilink",
        count: total,
        files: seriesFiles.map((f) => f.path),
      });
    }
  }

  // 3. Frontmatter `aliases`
  if (story.series) {
    // Scan the bibles for `aliases:` block — minimal; only files we already know.
    const bibles = [
      "CHARACTER_BIBLE.md",
      "World Bible v2.md",
      "CANON_REFERENCE_SUMMARY.md",
    ];
    for (const f of bibles) {
      try {
        const abs = join(cfg.VAULT_PATH, "Books", story.series, f);
        const content = await readFile(abs, "utf-8");
        const fmM = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
        if (!fmM) continue;
        const aliasesM = fmM[1]?.match(/aliases:\s*\n((?:\s*-\s+.+\n?)+)/);
        if (!aliasesM) continue;
        const lines = aliasesM[1]?.split(/\n/) ?? [];
        for (const ln of lines) {
          const m2 = ln.match(/^\s*-\s+(.+)$/);
          if (m2) {
            const term = m2[1]!.trim().replace(/^["']|["']$/g, "");
            if (term) entries.push({ term, source: "alias", files: [`Books/${story.series}/${f}`] });
          }
        }
      } catch {
        /* skip */
      }
    }
  }

  // Dedup, prefer style-lexicon > wikilink > alias
  const dedup = new Map<string, GlossaryEntry>();
  const priority: Record<GlossaryEntry["source"], number> = {
    "style-lexicon": 3,
    wikilink: 2,
    alias: 1,
  };
  for (const e of entries) {
    const lower = e.term.toLowerCase();
    const existing = dedup.get(lower);
    if (!existing || priority[e.source] > priority[existing.source]) {
      dedup.set(lower, e);
    }
  }

  const finalEntries = [...dedup.values()].sort((a, b) =>
    a.term.localeCompare(b.term)
  );

  return {
    story: { id: story.id, name: story.name, series: story.series },
    entries: finalEntries,
  };
}
