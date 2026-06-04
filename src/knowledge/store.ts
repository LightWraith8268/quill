// Knowledge-store accessors: entity/alias/fact/edge CRUD over the Phase 1
// tables, with canon-history logging. Series-scoped throughout.

import type { DB } from "../db.ts";
import {
  ENTITY_PREFIX,
  type CanonWeight,
  type EntityKind,
  type FactActor,
  type FactKind,
  type RelType,
  type ScopeType,
} from "./models.ts";

export type Entity = {
  id: number;
  stable_id: string;
  series: string | null;
  kind: string;
  name: string;
  canonical_name: string | null;
  tags: string;
  created_at: number;
  updated_at: number;
};

export function canonicalize(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function nextStableId(db: DB, kind: EntityKind): string {
  const prefix = ENTITY_PREFIX[kind];
  const row = db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM kb_entities WHERE stable_id LIKE ?"
    )
    .get(prefix + "%");
  return `${prefix}${(row?.n ?? 0) + 1}`;
}

// Find an entity in a series by canonical name OR a registered alias.
export function findEntity(
  db: DB,
  series: string | null,
  name: string
): Entity | null {
  const canon = canonicalize(name);
  const direct = db
    .query<Entity, [string | null, string | null, string]>(
      `SELECT * FROM kb_entities
       WHERE (series IS ? OR series = ?) AND canonical_name = ?
       ORDER BY id LIMIT 1`
    )
    .get(series, series, canon);
  if (direct) return direct;
  const viaAlias = db
    .query<Entity, [string | null, string | null, string]>(
      `SELECT e.* FROM kb_entities e
       JOIN kb_aliases a ON a.entity_id = e.id
       WHERE (e.series IS ? OR e.series = ?) AND LOWER(a.alias) = ?
       ORDER BY e.id LIMIT 1`
    )
    .get(series, series, canon);
  return viaAlias ?? null;
}

export function upsertEntity(
  db: DB,
  e: {
    series: string | null;
    kind: EntityKind;
    name: string;
    aliases?: string[];
    tags?: string[];
  }
): Entity {
  const existing = findEntity(db, e.series, e.name);
  const now = Date.now();
  if (existing) {
    if (e.tags?.length) {
      const merged = Array.from(
        new Set([...existing.tags.split(",").filter(Boolean), ...e.tags])
      ).join(",");
      db.prepare<unknown, [string, number, number]>(
        "UPDATE kb_entities SET tags = ?, updated_at = ? WHERE id = ?"
      ).run(merged, now, existing.id);
    }
    if (e.aliases?.length) addAliases(db, existing.id, e.aliases);
    return findEntity(db, e.series, e.name) ?? existing;
  }
  const stableId = nextStableId(db, e.kind);
  const row = db
    .query<Entity, [string, string | null, string, string, string, string, number, number]>(
      `INSERT INTO kb_entities (stable_id, series, kind, name, canonical_name, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
    )
    .get(
      stableId,
      e.series,
      e.kind,
      e.name,
      canonicalize(e.name),
      (e.tags ?? []).join(","),
      now,
      now
    );
  if (!row) throw new Error("entity insert failed");
  if (e.aliases?.length) addAliases(db, row.id, e.aliases);
  return row;
}

export function addAliases(db: DB, entityId: number, aliases: string[]): void {
  const stmt = db.prepare<unknown, [number, string]>(
    "INSERT OR IGNORE INTO kb_aliases (entity_id, alias) VALUES (?, ?)"
  );
  for (const a of aliases) {
    const trimmed = a.trim();
    if (trimmed) stmt.run(entityId, trimmed);
  }
}

export type FactInput = {
  entityId?: number | null;
  series: string | null;
  book?: string | null;
  scope?: ScopeType;
  kind?: FactKind;
  canonWeight?: CanonWeight;
  claim: string;
  status?: string | null;
  appliesFromBook?: string | null;
  appliesFromChapter?: number | null;
  appliesToBook?: string | null;
  appliesToChapter?: number | null;
  sourcePath?: string | null;
  sourceRef?: string | null;
  actor?: FactActor;
};

// Insert a fact (or update its claim/weight if an identical-subject fact exists
// for the same entity+scope), logging canon history either way.
export function addFact(db: DB, f: FactInput): number {
  const now = Date.now();
  const scope = f.scope ?? "series";
  const kind = f.kind ?? "fact";
  const weight = f.canonWeight ?? "soft_canon";

  const dupe = db
    .query<{ id: number; claim: string; canon_weight: string }, [number | null, string | null, string | null, string | null, string]>(
      `SELECT id, claim, canon_weight FROM kb_facts
       WHERE entity_id IS ? AND (series IS ? OR series = ?) AND book IS ?
         AND LOWER(claim) = LOWER(?)`
    )
    .get(f.entityId ?? null, f.series, f.series, f.book ?? null, f.claim);

  if (dupe) {
    if (dupe.canon_weight !== weight) {
      db.prepare<unknown, [string, number, number]>(
        "UPDATE kb_facts SET canon_weight = ?, updated_at = ? WHERE id = ?"
      ).run(weight, now, dupe.id);
      logFactHistory(db, {
        factId: dupe.id,
        entityId: f.entityId ?? null,
        changeType: "update",
        prevWeight: dupe.canon_weight,
        newWeight: weight,
        actor: f.actor,
      });
    }
    return dupe.id;
  }

  const row = db
    .query<{ id: number }, [
      number | null, string | null, string | null, string, string, string,
      string, string | null, string | null, number | null, string | null,
      number | null, string | null, string | null, string | null, number, number
    ]>(
      `INSERT INTO kb_facts
        (entity_id, series, book, scope, kind, canon_weight, claim, status,
         applies_from_book, applies_from_chapter, applies_to_book, applies_to_chapter,
         source_path, source_ref, actor, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .get(
      f.entityId ?? null,
      f.series,
      f.book ?? null,
      scope,
      kind,
      weight,
      f.claim,
      f.status ?? null,
      f.appliesFromBook ?? null,
      f.appliesFromChapter ?? null,
      f.appliesToBook ?? null,
      f.appliesToChapter ?? null,
      f.sourcePath ?? null,
      f.sourceRef ?? null,
      f.actor ?? "llm-extract",
      now,
      now
    );
  if (!row) throw new Error("fact insert failed");
  logFactHistory(db, {
    factId: row.id,
    entityId: f.entityId ?? null,
    changeType: "create",
    newClaim: f.claim,
    newWeight: weight,
    actor: f.actor,
  });
  return row.id;
}

export function logFactHistory(
  db: DB,
  h: {
    factId: number;
    entityId?: number | null;
    changeType: "create" | "update" | "delete" | "promote" | "demote";
    prevClaim?: string | null;
    newClaim?: string | null;
    prevWeight?: string | null;
    newWeight?: string | null;
    actor?: FactActor;
    snapshotId?: number | null;
  }
): void {
  db.prepare<unknown, [number, number | null, string, string | null, string | null, string | null, string | null, string | null, number | null, number]>(
    `INSERT INTO kb_fact_history
       (fact_id, entity_id, change_type, prev_claim, new_claim, prev_weight, new_weight, actor, snapshot_id, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    h.factId,
    h.entityId ?? null,
    h.changeType,
    h.prevClaim ?? null,
    h.newClaim ?? null,
    h.prevWeight ?? null,
    h.newWeight ?? null,
    h.actor ?? null,
    h.snapshotId ?? null,
    Date.now()
  );
}

export function addEdge(
  db: DB,
  e: {
    srcEntityId: number;
    dstEntityId: number;
    relType: RelType;
    directed?: boolean;
    description?: string | null;
    weight?: number;
    series?: string | null;
    auto?: boolean;
    sourcePath?: string | null;
  }
): void {
  if (e.srcEntityId === e.dstEntityId) return;
  db.prepare<unknown, [number, number, string, number, string | null, number, string | null, number, string | null, number]>(
    `INSERT OR IGNORE INTO kb_edges
       (src_entity_id, dst_entity_id, rel_type, directed, description, weight, series, auto, source_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    e.srcEntityId,
    e.dstEntityId,
    e.relType,
    e.directed === false ? 0 : 1,
    e.description ?? null,
    e.weight ?? 1.0,
    e.series ?? null,
    e.auto ? 1 : 0,
    e.sourcePath ?? null,
    Date.now()
  );
}

export function entityCount(db: DB, series?: string | null): number {
  if (series === undefined) {
    return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM kb_entities").get()?.n ?? 0;
  }
  return (
    db
      .query<{ n: number }, [string | null, string | null]>(
        "SELECT COUNT(*) AS n FROM kb_entities WHERE series IS ? OR series = ?"
      )
      .get(series, series)?.n ?? 0
  );
}

export function factCount(db: DB, series?: string | null): number {
  if (series === undefined) {
    return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM kb_facts").get()?.n ?? 0;
  }
  return (
    db
      .query<{ n: number }, [string | null, string | null]>(
        "SELECT COUNT(*) AS n FROM kb_facts WHERE series IS ? OR series = ?"
      )
      .get(series, series)?.n ?? 0
  );
}
