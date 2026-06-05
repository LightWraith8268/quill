// Self-building canon: as prose is written, extract candidate facts from a file
// and queue them for review (kb_pending_facts) rather than writing canon
// directly. Each candidate is classified `new` or `contradicts` against the
// series' existing canon, so contradictions surface the moment they're drafted.
// Accepting a candidate promotes it into the real canon graph (entity + fact).

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { DB } from "../db.ts";
import { getStory } from "../stories.ts";
import { claudeOnce } from "../agents/claude.ts";
import {
  coerceKind,
  coerceScope,
  coerceWeight,
  parseJsonLoose,
} from "./extract.ts";
import { addFact, upsertEntity } from "./store.ts";

export type PendingFact = {
  id: number;
  series: string | null;
  book: string | null;
  entity_name: string;
  entity_kind: string;
  claim: string;
  canon_weight: string;
  scope: string;
  classification: "new" | "contradicts";
  conflict_fact_id: number | null;
  conflict_claim: string | null;
  source_path: string | null;
  source_ref: string | null;
  status: string;
  created_at: number;
};

export type ProposeResult = {
  proposed: number;
  skipped: number;
  contradictions: number;
  model: string | null;
};

type RawPending = {
  entity_name?: string;
  entity_kind?: string;
  claim?: string;
  canon_weight?: string;
  status?: string; // new | contradicts | known
  contradicts_claim?: string | null;
};

const MAX_PROSE = 40_000;
const MAX_KNOWN = 400;

const PROPOSE_SYS = `You read a manuscript excerpt and surface canon facts it establishes, classifying each against the KNOWN canon already on file. Output STRICT JSON only — no prose, no markdown fences.

Schema:
{
  "facts": [
    {
      "entity_name": "the character/place/thing the fact is about",
      "entity_kind": "character|location|faction|magic|tech|artifact|species|event|rule|prophecy|glossary_term|world",
      "claim": "one concrete, self-contained fact stated as a sentence",
      "canon_weight": "draft_text|soft_canon|hard_canon|outline_plan|note",
      "status": "new|contradicts|known",
      "contradicts_claim": "the exact KNOWN claim it conflicts with, or null"
    }
  ]
}

Rules:
- "known": the fact is already represented in KNOWN canon — DO NOT emit these (skip them).
- "contradicts": the excerpt conflicts with a KNOWN claim. Set contradicts_claim to that known claim, copied verbatim.
- "new": genuinely new information about the world/characters not in KNOWN canon.
- Manuscript prose is "draft_text" unless it reads as an authoritative statement of canon.
- Prefer a few high-signal facts over many trivial ones. Skip stylistic/atmospheric lines.
- Only emit facts the excerpt actually supports. Do not invent.`;

type KnownFact = { id: number; claim: string };

function knownFactsFor(db: DB, series: string | null): KnownFact[] {
  return db
    .query<KnownFact, [string | null, string | null]>(
      `SELECT id, claim FROM kb_facts
       WHERE (series IS ? OR series = ?) AND canon_weight <> 'rejected'
       ORDER BY id DESC LIMIT ${MAX_KNOWN}`
    )
    .all(series, series);
}

function matchConflict(
  known: KnownFact[],
  claim: string | null | undefined
): KnownFact | null {
  if (!claim) return null;
  const c = claim.trim().toLowerCase();
  if (!c) return null;
  let best: KnownFact | null = null;
  for (const k of known) {
    const kc = k.claim.trim().toLowerCase();
    if (kc === c) return k;
    if (!best && (kc.includes(c) || c.includes(kc))) best = k;
  }
  return best;
}

// Already queued (pending) with an identical claim for this series? Avoid dupes.
function pendingExists(db: DB, series: string | null, claim: string): boolean {
  const row = db
    .query<{ n: number }, [string | null, string | null, string]>(
      `SELECT COUNT(*) AS n FROM kb_pending_facts
       WHERE (series IS ? OR series = ?) AND status = 'pending' AND LOWER(claim) = LOWER(?)`
    )
    .get(series, series, claim);
  return (row?.n ?? 0) > 0;
}

export async function proposeFromText(
  cfg: Config,
  db: DB,
  args: {
    series: string | null;
    book: string | null;
    sourcePath: string | null;
    content: string;
  }
): Promise<ProposeResult> {
  const prose = args.content.slice(0, MAX_PROSE).trim();
  if (prose.length < 200) {
    return { proposed: 0, skipped: 0, contradictions: 0, model: null };
  }

  const known = knownFactsFor(db, args.series);
  const knownBlock = known.length
    ? known.map((k) => `- ${k.claim}`).join("\n")
    : "(no canon on file yet — everything substantive is new)";

  const prompt = `${PROPOSE_SYS}

=== KNOWN CANON (series: ${args.series ?? "?"}) ===
${knownBlock}

=== MANUSCRIPT EXCERPT${args.sourcePath ? ` (${args.sourcePath})` : ""} ===
${prose}`;

  let model: string | null = null;
  const text = await claudeOnce(prompt, {
    cwd: cfg.VAULT_PATH,
    skipMcp: true,
    model: cfg.CLAUDE_FAST_MODEL || undefined,
    onUsage: (u) => {
      model = u.model ?? model;
    },
  });

  const parsed = parseJsonLoose<{ facts?: RawPending[] }>(text);
  const raw = parsed?.facts ?? [];

  let proposed = 0;
  let skipped = 0;
  let contradictions = 0;
  const now = Date.now();

  const insert = db.prepare<unknown, [
    string | null, string | null, string, string, string, string, string,
    string, number | null, string | null, string | null, number
  ]>(
    `INSERT INTO kb_pending_facts
       (series, book, entity_name, entity_kind, claim, canon_weight, scope,
        classification, conflict_fact_id, conflict_claim, source_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const tx = db.transaction(() => {
    for (const f of raw) {
      const status = (f.status ?? "new").toLowerCase();
      if (status === "known") {
        skipped++;
        continue;
      }
      if (!f.entity_name || !f.claim) {
        skipped++;
        continue;
      }
      if (pendingExists(db, args.series, f.claim)) {
        skipped++;
        continue;
      }
      const classification = status === "contradicts" ? "contradicts" : "new";
      const conflict =
        classification === "contradicts"
          ? matchConflict(known, f.contradicts_claim)
          : null;
      if (classification === "contradicts") contradictions++;
      insert.run(
        args.series,
        args.book,
        f.entity_name.trim(),
        coerceKind(f.entity_kind),
        f.claim.trim(),
        coerceWeight(f.canon_weight ?? "draft_text"),
        "book",
        classification,
        conflict?.id ?? null,
        conflict?.claim ?? f.contradicts_claim ?? null,
        args.sourcePath,
        now
      );
      proposed++;
    }
  });
  tx();

  return { proposed, skipped, contradictions, model };
}

// Gather a story's manuscript prose (one file, or the whole folder concatenated)
// and run it through the proposer. Bibles are excluded — they're already canon.
async function gatherProse(
  cfg: Config,
  storyPath: string,
  relPath?: string | null
): Promise<{ content: string; sourcePath: string | null }> {
  if (relPath) {
    const content = await readFile(join(cfg.VAULT_PATH, relPath), "utf-8");
    return { content, sourcePath: relPath };
  }
  const root = join(cfg.VAULT_PATH, storyPath);
  const parts: string[] = [];
  const walk = async (absDir: string, relDir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (/\.bak/i.test(e.name)) continue;
      const abs = join(absDir, e.name);
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(abs, rel);
      } else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) {
        try {
          parts.push(`=== ${rel} ===\n${await readFile(abs, "utf-8")}`);
        } catch {
          /* skip */
        }
      }
    }
  };
  await walk(root, "");
  return { content: parts.join("\n\n"), sourcePath: storyPath };
}

export async function proposeFromStory(
  cfg: Config,
  db: DB,
  storyId: number,
  relPath?: string | null
): Promise<ProposeResult> {
  const story = getStory(db, storyId);
  if (!story) throw new Error(`story ${storyId} not found`);
  const { content, sourcePath } = await gatherProse(cfg, story.path, relPath);
  return proposeFromText(cfg, db, {
    series: story.series,
    book: story.name,
    sourcePath,
    content,
  });
}

export function listPending(
  db: DB,
  series: string | null,
  limit = 100
): PendingFact[] {
  return db
    .query<PendingFact, [string | null, string | null, number]>(
      `SELECT * FROM kb_pending_facts
       WHERE (series IS ? OR series = ?) AND status = 'pending'
       ORDER BY (classification = 'contradicts') DESC, created_at DESC
       LIMIT ?`
    )
    .all(series, series, limit);
}

export function pendingCount(db: DB, series: string | null): number {
  return (
    db
      .query<{ n: number }, [string | null, string | null]>(
        `SELECT COUNT(*) AS n FROM kb_pending_facts
         WHERE (series IS ? OR series = ?) AND status = 'pending'`
      )
      .get(series, series)?.n ?? 0
  );
}

function getPending(db: DB, id: number): PendingFact | null {
  return (
    db
      .query<PendingFact, [number]>("SELECT * FROM kb_pending_facts WHERE id = ?")
      .get(id) ?? null
  );
}

// Promote a queued candidate into the real canon graph: ensure the entity
// exists, then add the fact (sourced + actor 'reviewer'). Marks the row accepted.
export function acceptPending(db: DB, id: number): { factId: number } {
  const p = getPending(db, id);
  if (!p) throw new Error(`pending fact ${id} not found`);
  if (p.status !== "pending") throw new Error(`pending fact ${id} already ${p.status}`);

  let factId = 0;
  const tx = db.transaction(() => {
    const ent = upsertEntity(db, {
      series: p.series,
      kind: coerceKind(p.entity_kind),
      name: p.entity_name,
    });
    factId = addFact(db, {
      entityId: ent.id,
      series: p.series,
      book: p.book,
      scope: coerceScope(p.scope),
      canonWeight: coerceWeight(p.canon_weight),
      claim: p.claim,
      sourcePath: p.source_path,
      sourceRef: p.source_ref,
      actor: "reviewer",
    });
    db.prepare<unknown, [number, number]>(
      "UPDATE kb_pending_facts SET status = 'accepted', decided_at = ? WHERE id = ?"
    ).run(Date.now(), id);
  });
  tx();
  return { factId };
}

export function rejectPending(db: DB, id: number): void {
  const p = getPending(db, id);
  if (!p) throw new Error(`pending fact ${id} not found`);
  db.prepare<unknown, [number, number]>(
    "UPDATE kb_pending_facts SET status = 'rejected', decided_at = ? WHERE id = ?"
  ).run(Date.now(), id);
}

export function clearPending(db: DB, series: string | null): number {
  const res = db
    .prepare<unknown, [string | null, string | null]>(
      `UPDATE kb_pending_facts SET status = 'rejected', decided_at = strftime('%s','now')*1000
       WHERE (series IS ? OR series = ?) AND status = 'pending'`
    )
    .run(series, series);
  return Number(res.changes ?? 0);
}
