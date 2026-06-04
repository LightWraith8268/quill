// Knowledge-layer model — ported from writerbrain's models.py.
// Typed entities, canon-weight authority tiers, scope hierarchy, and the
// rank/bonus maps that canon-aware retrieval uses for reranking.

export const ENTITY_KINDS = [
  "character",
  "location",
  "faction",
  "magic",
  "tech",
  "artifact",
  "species",
  "event",
  "rule",
  "prophecy",
  "glossary_term",
  "world",
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

// Human-readable stable_id prefixes (C1, L3, …).
export const ENTITY_PREFIX: Record<EntityKind, string> = {
  character: "C",
  location: "L",
  faction: "F",
  magic: "M",
  tech: "T",
  artifact: "A",
  species: "S",
  event: "E",
  rule: "R",
  prophecy: "P",
  glossary_term: "G",
  world: "W",
};

// Canon authority, highest first. `CANON_RANK` is lower = more authoritative;
// retrieval reranks so hard_canon always outranks draft_text, and rejected sinks.
export const CANON_WEIGHTS = [
  "hard_canon",
  "soft_canon",
  "outline_plan",
  "draft_text",
  "note",
  "rejected",
] as const;
export type CanonWeight = (typeof CANON_WEIGHTS)[number];

export const CANON_RANK: Record<CanonWeight, number> = {
  hard_canon: 0,
  soft_canon: 1,
  outline_plan: 2,
  draft_text: 3,
  note: 4,
  rejected: 9,
};

// Scope hierarchy: facts inherit downward (series-level applies to its books /
// chapters unless overridden). Narrower scope = smaller distance in rerank.
export type ScopeType = "global" | "series" | "book" | "chapter" | "scene";
export const SCOPE_NARROW_FIRST: ScopeType[] = [
  "scene",
  "chapter",
  "book",
  "series",
  "global",
];
export function scopeDistance(scope: ScopeType): number {
  const i = SCOPE_NARROW_FIRST.indexOf(scope);
  return i < 0 ? SCOPE_NARROW_FIRST.length : i;
}

export type FactKind = "fact" | "decision" | "timeline" | "summary" | "memory";

// Retrieval kind bonuses (writerbrain): structured canon outranks raw chunks.
export const KIND_BONUS: Record<string, number> = {
  fact: 5.0,
  decision: 4.0,
  summary: 2.5,
  timeline: 2.0,
  memory: 1.0,
  chunk: 0.0,
};

// Who/what wrote a fact — audit trail for canon history.
export type FactActor = "manual" | "auto-import" | "llm-extract" | "reviewer";

// Free-form typed relationship edges (ally, enemy, located-in, member-of,
// mentor, mentioned-in, …). Kept open rather than enumerated.
export type RelType = string;
export const REL_MENTIONED_IN: RelType = "mentioned-in";
