// Canon versioning: freeze a series' entity+fact state into a named snapshot,
// list snapshots, diff two snapshots (added/removed/reweighted facts), and read
// a fact's change log. Fact-level history rows are written by store.addFact.

import type { DB } from "../db.ts";

export type SnapshotFact = {
  id: number;
  claim: string;
  canon_weight: string;
  scope: string;
  book: string | null;
};
export type SnapshotEntity = {
  stable_id: string;
  kind: string;
  name: string;
  aliases: string[];
  tags: string;
  facts: SnapshotFact[];
};
export type SnapshotState = { series: string | null; at: number; entities: SnapshotEntity[] };

export function createSnapshot(
  db: DB,
  series: string | null,
  name: string,
  note?: string
): number {
  const ents = db
    .query<{ id: number; stable_id: string; kind: string; name: string; tags: string }, [string | null, string | null]>(
      "SELECT id, stable_id, kind, name, tags FROM kb_entities WHERE series IS ? OR series = ? ORDER BY id"
    )
    .all(series, series);

  const entities: SnapshotEntity[] = ents.map((e) => ({
    stable_id: e.stable_id,
    kind: e.kind,
    name: e.name,
    tags: e.tags,
    aliases: db
      .query<{ alias: string }, [number]>("SELECT alias FROM kb_aliases WHERE entity_id = ?")
      .all(e.id)
      .map((r) => r.alias),
    facts: db
      .query<SnapshotFact, [number]>(
        "SELECT id, claim, canon_weight, scope, book FROM kb_facts WHERE entity_id = ? ORDER BY id"
      )
      .all(e.id),
  }));

  const state: SnapshotState = { series, at: Date.now(), entities };
  const row = db
    .query<{ id: number }, [string | null, string, string | null, string, number]>(
      "INSERT INTO kb_snapshots (series, name, note, state, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id"
    )
    .get(series, name, note ?? null, JSON.stringify(state), Date.now());
  if (!row) throw new Error("snapshot insert failed");
  return row.id;
}

export type SnapshotMeta = {
  id: number;
  series: string | null;
  name: string;
  note: string | null;
  created_at: number;
};

export function listSnapshots(db: DB, series?: string | null): SnapshotMeta[] {
  if (series === undefined) {
    return db
      .query<SnapshotMeta, []>(
        "SELECT id, series, name, note, created_at FROM kb_snapshots ORDER BY created_at DESC"
      )
      .all();
  }
  return db
    .query<SnapshotMeta, [string | null, string | null]>(
      "SELECT id, series, name, note, created_at FROM kb_snapshots WHERE series IS ? OR series = ? ORDER BY created_at DESC"
    )
    .all(series, series);
}

export function getSnapshotState(db: DB, id: number): SnapshotState | null {
  const row = db
    .query<{ state: string }, [number]>("SELECT state FROM kb_snapshots WHERE id = ?")
    .get(id);
  if (!row) return null;
  try {
    return JSON.parse(row.state) as SnapshotState;
  } catch {
    return null;
  }
}

export type FactDiff = {
  entity: string;
  claim: string;
  type: "added" | "removed" | "reweighted";
  from?: string;
  to?: string;
};

export function diffSnapshots(db: DB, idA: number, idB: number): FactDiff[] {
  const a = getSnapshotState(db, idA);
  const b = getSnapshotState(db, idB);
  if (!a || !b) throw new Error("snapshot not found");

  const index = (s: SnapshotState): Map<string, { ent: string; w: string; claim: string }> => {
    const m = new Map<string, { ent: string; w: string; claim: string }>();
    for (const e of s.entities) {
      for (const f of e.facts) {
        m.set(`${e.stable_id}∷${f.claim.toLowerCase()}`, {
          ent: e.name,
          w: f.canon_weight,
          claim: f.claim,
        });
      }
    }
    return m;
  };
  const aMap = index(a);
  const bMap = index(b);
  const diffs: FactDiff[] = [];

  for (const [k, v] of bMap) {
    const old = aMap.get(k);
    if (!old) diffs.push({ entity: v.ent, claim: v.claim, type: "added", to: v.w });
    else if (old.w !== v.w)
      diffs.push({ entity: v.ent, claim: v.claim, type: "reweighted", from: old.w, to: v.w });
  }
  for (const [k, v] of aMap) {
    if (!bMap.has(k)) diffs.push({ entity: v.ent, claim: v.claim, type: "removed", from: v.w });
  }
  return diffs;
}

export type FactHistoryRow = {
  change_type: string;
  prev_claim: string | null;
  new_claim: string | null;
  prev_weight: string | null;
  new_weight: string | null;
  actor: string | null;
  at: number;
};

export function factHistory(db: DB, factId: number): FactHistoryRow[] {
  return db
    .query<FactHistoryRow, [number]>(
      `SELECT change_type, prev_claim, new_claim, prev_weight, new_weight, actor, at
       FROM kb_fact_history WHERE fact_id = ? ORDER BY at`
    )
    .all(factId);
}
