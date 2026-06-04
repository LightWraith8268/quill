// Derive series/book scope from a vault-relative path.
// Vault layout: Books/<series>/<book>/<…>. "Story Ideas/<x>/…" → series only.

export type Scope = { series: string | null; book: string | null };

export function scopeFromPath(relPath: string): Scope {
  const parts = relPath.split(/[/\\]/).filter(Boolean);
  if (parts[0] === "Books") {
    return { series: parts[1] ?? null, book: parts[2] ?? null };
  }
  if (parts[0] === "Story Ideas") {
    return { series: parts[1] ?? null, book: null };
  }
  return { series: null, book: null };
}
