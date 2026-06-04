// Render retrieved canon into a hierarchical, canon-labeled context block for
// the chat system prompt. Facts are grouped by authority so the model is told,
// explicitly, what is locked canon vs provisional draft.

import type { CanonItem } from "./retrieve.ts";

const WEIGHT_LABEL: Record<string, string> = {
  hard_canon: "HARD CANON (locked — authoritative, must be respected)",
  soft_canon: "SOFT CANON (established, but softer)",
  outline_plan: "OUTLINE / PLAN (intended, not yet written)",
  draft_text: "DRAFT (provisional — may change; do NOT cite as established fact)",
  note: "NOTES",
  memory: "SESSION NOTES",
};
const WEIGHT_ORDER = ["hard_canon", "soft_canon", "outline_plan", "draft_text", "note", "memory"];

export function renderCanonPack(
  facts: CanonItem[],
  chunks: CanonItem[],
  opts: { previewChars: number }
): string {
  const lines: string[] = [];

  if (facts.length > 0) {
    lines.push(
      `=== CANON KNOWLEDGE (ranked; respect canon weight — never present DRAFT as established fact) ===`
    );
    const groups = new Map<string, CanonItem[]>();
    for (const f of facts) {
      const w = f.canonWeight ?? "note";
      (groups.get(w) ?? groups.set(w, []).get(w)!).push(f);
    }
    for (const w of WEIGHT_ORDER) {
      const g = groups.get(w);
      if (!g?.length) continue;
      lines.push(`-- ${WEIGHT_LABEL[w] ?? w} --`);
      for (const f of g) {
        const who = f.entity ? `${f.entity}: ` : "";
        const ref = f.sourcePath
          ? `  (${f.sourcePath}${f.sourceRef ? " :: " + f.sourceRef : ""})`
          : "";
        lines.push(`- ${who}${f.text}${ref}`);
      }
      lines.push("");
    }
  }

  if (chunks.length > 0) {
    lines.push(`=== RELEVANT LORE (retrieval, scoped to this series/book) ===`);
    for (const h of chunks) {
      const head = h.sourceRef ? ` :: ${h.sourceRef}` : "";
      const preview =
        h.text.length > opts.previewChars ? h.text.slice(0, opts.previewChars) + "…" : h.text;
      lines.push(`--- ${h.sourcePath ?? ""}${head} ---`);
      lines.push(preview);
      lines.push("");
    }
  }

  return lines.join("\n").trim();
}
