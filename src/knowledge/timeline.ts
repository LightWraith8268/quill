// Timeline + character-knowledge state. Canon facts carry temporal bounds
// (applies_from_chapter / applies_to_chapter within a book). This module reads
// the canon "as of chapter N": which facts are already established (so the
// writing agent may use them) vs. which are future reveals (so it must NOT
// reference them yet). The continuity safeguard for serialized fiction.

import type { DB } from "../db.ts";

export type TimelineFact = {
  id: number;
  entity_id: number | null;
  entity: string | null;
  kind: string;
  claim: string;
  canon_weight: string;
  book: string | null;
  applies_from_book: string | null;
  applies_from_chapter: number | null;
  applies_to_book: string | null;
  applies_to_chapter: number | null;
};

type FactRow = TimelineFact;

const SELECT = `
  SELECT f.id, f.entity_id, e.name AS entity, f.kind, f.claim, f.canon_weight,
         f.book, f.applies_from_book, f.applies_from_chapter,
         f.applies_to_book, f.applies_to_chapter
  FROM kb_facts f
  LEFT JOIN kb_entities e ON e.id = f.entity_id
`;

// All facts in scope that carry an explicit chapter bound — the reveal timeline.
export function timelineEvents(
  db: DB,
  series: string | null,
  book?: string | null
): TimelineFact[] {
  const rows = db
    .query<FactRow, [string | null, string | null]>(
      `${SELECT}
       WHERE (f.series IS ? OR f.series = ?)
         AND f.canon_weight <> 'rejected'
         AND (f.applies_from_chapter IS NOT NULL OR f.applies_to_chapter IS NOT NULL)
       ORDER BY COALESCE(f.applies_from_chapter, 0), f.id`
    )
    .all(series, series);
  return book ? rows.filter((r) => sameBook(r, book)) : rows;
}

function sameBook(r: FactRow, book: string): boolean {
  // A bounded fact belongs to the selected book if its book or applies_from_book
  // matches (or is unset → treated as applying within the current book).
  return (
    r.book == null ||
    r.book === book ||
    r.applies_from_book == null ||
    r.applies_from_book === book
  );
}

export type KnowledgeState = {
  chapter: number;
  book: string | null;
  active: TimelineFact[]; // established at/before this chapter
  future: TimelineFact[]; // not yet revealed (applies_from_chapter > chapter)
};

// Canon as of a chapter: established facts (usable) vs future reveals (off-limits).
// Facts with no from-bound are timeless canon → always active. Facts whose
// to-bound has passed (applies_to_chapter < chapter) drop out of `active`.
export function knowledgeStateAt(
  db: DB,
  series: string | null,
  book: string | null,
  chapter: number
): KnowledgeState {
  const rows = db
    .query<FactRow, [string | null, string | null]>(
      `${SELECT}
       WHERE (f.series IS ? OR f.series = ?) AND f.canon_weight <> 'rejected'
       ORDER BY COALESCE(f.applies_from_chapter, 0), f.id`
    )
    .all(series, series)
    .filter((r) => (book ? sameBook(r, book) : true));

  const active: TimelineFact[] = [];
  const future: TimelineFact[] = [];
  for (const r of rows) {
    const from = r.applies_from_chapter;
    const to = r.applies_to_chapter;
    if (from != null && from > chapter) {
      future.push(r);
    } else if (to != null && to < chapter) {
      // expired before this chapter — neither current nor future
    } else {
      active.push(r);
    }
  }
  return { chapter, book, active, future };
}

// Facts a single entity is the subject of, as of a chapter — "what X knows /
// what's true about X at chapter N". (Subject-of, the practical proxy.)
export function entityStateAt(
  db: DB,
  series: string | null,
  book: string | null,
  entityId: number,
  chapter: number
): { active: TimelineFact[]; future: TimelineFact[] } {
  const st = knowledgeStateAt(db, series, book, chapter);
  return {
    active: st.active.filter((f) => f.entity_id === entityId),
    future: st.future.filter((f) => f.entity_id === entityId),
  };
}

// The largest chapter referenced by any bound, so the UI can size its slider.
export function maxChapter(db: DB, series: string | null): number {
  const row = db
    .query<{ m: number | null }, [string | null, string | null]>(
      `SELECT MAX(MAX(COALESCE(applies_from_chapter,0), COALESCE(applies_to_chapter,0))) AS m
       FROM kb_facts WHERE series IS ? OR series = ?`
    )
    .get(series, series);
  return Math.max(row?.m ?? 0, 1);
}

export function setFactBounds(
  db: DB,
  factId: number,
  bounds: {
    fromBook?: string | null;
    fromChapter?: number | null;
    toBook?: string | null;
    toChapter?: number | null;
  }
): void {
  db.prepare<unknown, [
    string | null, number | null, string | null, number | null, number, number
  ]>(
    `UPDATE kb_facts
       SET applies_from_book = ?, applies_from_chapter = ?,
           applies_to_book = ?, applies_to_chapter = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    bounds.fromBook ?? null,
    bounds.fromChapter ?? null,
    bounds.toBook ?? null,
    bounds.toChapter ?? null,
    Date.now(),
    factId
  );
}
