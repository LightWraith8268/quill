// CHARACTER_BIBLE.md parser. Walks H2 (character names) → H3 (subsections);
// fuzzy-matches common subsection titles into structured fields, falls back
// to a generic `sections[]` for unrecognized H3s. Designed to be tolerant of
// formatting drift across series.

import { readdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";

export type AgeEntry = { book: string; age: string };
export type ArcEntry = { book: string; beats: string[] };
export type Relationship = { partner: string; description: string };
export type GenericSection = { heading: string; content: string };

export type Character = {
  name: string;
  role: string | null;
  tags: string[];
  agePerBook: AgeEntry[];
  voiceSummary: string | null;
  coreDrives: string[];
  arc: ArcEntry[];
  relationships: Relationship[];
  writingTics: string[];
  sections: GenericSection[];
};

export type CharacterBible = {
  series: string;
  characters: Character[];
};

// Strip frontmatter block and the canon-law / corrections preamble before the
// first H2 — anything outside character sections.
function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  if (end < 0) return content;
  // Skip past trailing newline
  const after = content.indexOf("\n", end + 4);
  return after < 0 ? "" : content.slice(after + 1);
}

// Split on H2 lines (`^## ...$`). Returns [{name, body}] for each character.
function splitOnH2(content: string): { name: string; body: string }[] {
  const lines = content.split("\n");
  const blocks: { name: string; body: string }[] = [];
  let current: { name: string; bodyLines: string[] } | null = null;
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m && !line.startsWith("###")) {
      if (current) blocks.push({ name: current.name, body: current.bodyLines.join("\n") });
      // Strip parenthetical book-introduction notes like "(Book 2 introduction)"
      const rawName = (m[1] ?? "").trim();
      const cleaned = rawName.replace(/\s*\(.*?\)\s*$/, "").trim();
      current = { name: cleaned || rawName, bodyLines: [] };
    } else if (current) {
      current.bodyLines.push(line);
    }
  }
  if (current) blocks.push({ name: current.name, body: current.bodyLines.join("\n") });
  // Filter out non-character H2 blocks (e.g., "CHARACTER CONSISTENCY RULES").
  return blocks.filter((b) => {
    const lower = b.name.toLowerCase();
    if (/consistency rules?/i.test(lower)) return false;
    if (/^canon /i.test(lower)) return false;
    return true;
  });
}

// Split a character body on H3 lines.
function splitOnH3(body: string): { heading: string; content: string }[] {
  const lines = body.split("\n");
  const out: { heading: string; content: string }[] = [];
  let preamble: string[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  for (const line of lines) {
    const m = /^###\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (current) out.push({ heading: current.heading, content: current.lines.join("\n").trim() });
      else if (preamble.length) {
        out.push({ heading: "__preamble__", content: preamble.join("\n").trim() });
        preamble = [];
      }
      current = { heading: (m[1] ?? "").trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) out.push({ heading: current.heading, content: current.lines.join("\n").trim() });
  else if (preamble.length) out.push({ heading: "__preamble__", content: preamble.join("\n").trim() });
  return out;
}

// Pull bullet items from arbitrary content. Returns trimmed item text without
// the leading `- ` / `* ` / numeric prefix.
function bulletItems(content: string): string[] {
  const out: string[] = [];
  const re = /^[\s]*(?:[-*+]|\d+\.)\s+(.*)$/;
  for (const line of content.split("\n")) {
    const m = re.exec(line);
    if (m) out.push((m[1] ?? "").trim());
  }
  return out;
}

// Parse "**Book N:** value" patterns from a content block (one per line).
// Returns ordered key/value list. Used by Age Progression.
function parseBookKv(content: string): { book: string; value: string }[] {
  const out: { book: string; value: string }[] = [];
  // Try bullet form first: `- **Book 1:** 17`
  const reBullet = /^[\s]*[-*+]\s+\*\*([^*]+?)\*\*[:\-\s]+(.+)$/;
  // Plain form fallback: `**Book 1:** 17`
  const rePlain = /^\s*\*\*([^*]+?)\*\*[:\-\s]+(.+)$/;
  for (const line of content.split("\n")) {
    let m = reBullet.exec(line);
    if (!m) m = rePlain.exec(line);
    if (m) {
      const key = (m[1] ?? "").trim().replace(/[:\s]+$/, "");
      const value = (m[2] ?? "").trim();
      out.push({ book: key, value });
    }
  }
  return out;
}

// Parse Character Arc body: groups of `**Book N: subtitle**` followed by
// bullet beats until the next `**Book N` header.
function parseArc(content: string): ArcEntry[] {
  const lines = content.split("\n");
  const out: ArcEntry[] = [];
  let current: { book: string; beatLines: string[] } | null = null;
  // Header forms:
  //   **Book 1: Dropout → Nexus**
  //   **Book 1 (planned): X**
  //   **Book 3 (planned): Y**
  const headerRe = /^\s*\*\*(Book\s+[^:*]+?)(?::\s*([^*]*?))?\*\*\s*$/i;
  for (const line of lines) {
    const m = headerRe.exec(line);
    if (m) {
      if (current) out.push({ book: current.book, beats: bulletItems(current.beatLines.join("\n")) });
      const book = (m[1] ?? "").trim();
      const subtitle = (m[2] ?? "").trim();
      const display = subtitle ? `${book}: ${subtitle}` : book;
      current = { book: display, beatLines: [] };
    } else if (current) {
      current.beatLines.push(line);
    }
  }
  if (current) out.push({ book: current.book, beats: bulletItems(current.beatLines.join("\n")) });
  return out;
}

// Relationship Map bullet pattern: `- **Partner:** description`
function parseRelationships(content: string): Relationship[] {
  const out: Relationship[] = [];
  const re = /^[\s]*[-*+]\s+\*\*([^*]+?)\*\*[:\-\s]+(.+)$/;
  for (const line of content.split("\n")) {
    const m = re.exec(line);
    if (m) {
      out.push({ partner: (m[1] ?? "").trim().replace(/[:\s]+$/, ""), description: (m[2] ?? "").trim() });
    }
  }
  return out;
}

// Pull the role + tags + voice/personality summary out of the H3="__preamble__"
// block. Bold-prefixed fields look like:  `**Role:** ...`  `**Tags:** #a #b`
function parsePreamble(preamble: string): {
  role: string | null;
  tags: string[];
  rest: string;
} {
  let role: string | null = null;
  const tags: string[] = [];
  const restLines: string[] = [];
  for (const line of preamble.split("\n")) {
    const roleM = /^\s*\*\*Role:\*\*\s*(.+?)\s*$/i.exec(line);
    if (roleM) {
      role = (roleM[1] ?? "").trim();
      continue;
    }
    const tagsM = /^\s*\*\*Tags?:\*\*\s*(.+?)\s*$/i.exec(line);
    if (tagsM) {
      const raw = tagsM[1] ?? "";
      const found = raw.match(/#[\w\-/]+/g) ?? [];
      for (const t of found) tags.push(t.replace(/^#/, ""));
      // also accept comma-separated bare words
      if (found.length === 0) {
        for (const part of raw.split(/[,\s]+/)) {
          const trimmed = part.trim();
          if (trimmed) tags.push(trimmed.replace(/^#/, ""));
        }
      }
      continue;
    }
    restLines.push(line);
  }
  return { role, tags, rest: restLines.join("\n").trim() };
}

// Pull a one-paragraph summary out of the Voice & Personality content block.
// Prefers the `**Core Voice:**` / `**Core voice:**` line if present; falls
// back to the first bullet item; falls back to the first non-empty line.
function summarizeVoice(content: string): string {
  const coreM = /\*\*Core\s+[Vv]oice:?\*\*\s*(.+)/i.exec(content);
  if (coreM) return (coreM[1] ?? "").trim();
  const bullets = bulletItems(content);
  if (bullets.length > 0) {
    return (bullets[0] ?? "").replace(/^\*\*[^*]+\*\*\s*[:\-]?\s*/, "").trim();
  }
  const firstLine = content.split("\n").find((l) => l.trim().length > 0);
  return (firstLine ?? "").trim();
}

function classify(heading: string): string {
  const h = heading.toLowerCase();
  if (/^age\s+progress/i.test(h)) return "age";
  if (/^voice|^writing rules?/i.test(h)) return "voice";
  if (/^core\s+drives?/i.test(h)) return "drives";
  if (/^character\s+arc/i.test(h)) return "arc";
  if (/^relationship/i.test(h)) return "relationships";
  if (/^writing\s+tics?/i.test(h)) return "tics";
  if (h === "__preamble__") return "preamble";
  return "other";
}

export function parseCharacterBible(content: string): Character[] {
  const stripped = stripFrontmatter(content);
  const blocks = splitOnH2(stripped);
  const out: Character[] = [];
  for (const block of blocks) {
    const subsections = splitOnH3(block.body);

    let role: string | null = null;
    let tags: string[] = [];
    let voiceSummary: string | null = null;
    let agePerBook: AgeEntry[] = [];
    let coreDrives: string[] = [];
    let arc: ArcEntry[] = [];
    let relationships: Relationship[] = [];
    let writingTics: string[] = [];
    const otherSections: GenericSection[] = [];

    // The H3 preamble may also contain "**Age:** Late 20s" — capture as a
    // single-entry agePerBook fallback when no Age Progression block exists.
    let preambleAge: string | null = null;

    for (const sub of subsections) {
      const kind = classify(sub.heading);
      switch (kind) {
        case "preamble": {
          const pre = parsePreamble(sub.content);
          role = pre.role;
          tags = pre.tags;
          // Look for `**Age:** ...` in the preamble rest
          const ageM = /\*\*Age:?\*\*\s*(.+)/i.exec(pre.rest);
          if (ageM) preambleAge = ((ageM[1] ?? "").split("\n")[0] ?? "").trim();
          // Preamble content not consumed otherwise — keep the rest as a
          // generic section so nothing is lost (e.g., classification block,
          // canonical phrase quotes).
          if (pre.rest.trim().length > 0) {
            otherSections.push({ heading: "Overview", content: pre.rest });
          }
          break;
        }
        case "age": {
          const kv = parseBookKv(sub.content);
          agePerBook = kv.map((entry) => ({ book: entry.book, age: entry.value }));
          // Capture trailing prose after the `**Book N:**` lines as an
          // additional generic section so nothing is dropped.
          const proseLines: string[] = [];
          for (const line of sub.content.split("\n")) {
            if (/^\s*[-*+]?\s*\*\*Book\s/i.test(line)) continue;
            proseLines.push(line);
          }
          const prose = proseLines.join("\n").trim();
          if (prose.length > 0) {
            otherSections.push({ heading: "Age Progression — notes", content: prose });
          }
          break;
        }
        case "voice": {
          voiceSummary = summarizeVoice(sub.content);
          // Always retain the full voice block in `sections` for reference.
          otherSections.push({ heading: sub.heading, content: sub.content });
          break;
        }
        case "drives":
          coreDrives = bulletItems(sub.content);
          break;
        case "arc":
          arc = parseArc(sub.content);
          break;
        case "relationships":
          relationships = parseRelationships(sub.content);
          break;
        case "tics":
          writingTics = bulletItems(sub.content);
          break;
        default:
          otherSections.push({ heading: sub.heading, content: sub.content });
      }
    }

    // Fallback: if no Age Progression block but preamble had `**Age:** ...`,
    // surface it as a single entry so the timeline still renders something.
    if (agePerBook.length === 0 && preambleAge) {
      agePerBook = [{ book: "All books", age: preambleAge }];
    }

    out.push({
      name: block.name,
      role,
      tags,
      agePerBook,
      voiceSummary,
      coreDrives,
      arc,
      relationships,
      writingTics,
      sections: otherSections,
    });
  }
  return out;
}

// ===== Series discovery =====

export type CharacterSeriesSummary = {
  series: string;
  characterCount: number;
};

export async function listCharacterBibles(
  cfg: Config
): Promise<CharacterSeriesSummary[]> {
  const booksDir = join(cfg.VAULT_PATH, "Books");
  let entries: { name: string; isDir: boolean }[];
  try {
    const dirEntries = await readdir(booksDir, { withFileTypes: true });
    entries = dirEntries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return [];
  }
  const out: CharacterSeriesSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDir) continue;
    if (entry.name.startsWith(".")) continue;
    const bibleAbs = join(booksDir, entry.name, "CHARACTER_BIBLE.md");
    try {
      const st = await stat(bibleAbs);
      if (!st.isFile()) continue;
      const content = await readFile(bibleAbs, "utf-8");
      const characters = parseCharacterBible(content);
      out.push({ series: entry.name, characterCount: characters.length });
    } catch {
      // no bible in this series — skip
    }
  }
  out.sort((a, b) => a.series.localeCompare(b.series));
  return out;
}

export async function readCharacterBible(
  cfg: Config,
  series: string
): Promise<CharacterBible | null> {
  if (!series || series.includes("..") || series.includes("/") || series.includes("\\")) {
    return null;
  }
  const bibleAbs = join(cfg.VAULT_PATH, "Books", series, "CHARACTER_BIBLE.md");
  try {
    const st = await stat(bibleAbs);
    if (!st.isFile()) return null;
  } catch {
    return null;
  }
  const content = await readFile(bibleAbs, "utf-8");
  const characters = parseCharacterBible(content);
  return { series, characters };
}
