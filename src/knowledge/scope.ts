// Derive series/book scope from a writing-root-relative path, using
// configurable path patterns (SCOPE_PATTERNS). A pattern is a slash path whose
// segments are either literals (matched case-insensitively against the start of
// the path) or the placeholders :series / :book. First matching pattern wins.
//
//   Books/:series/:book                       (default vault layout)
//   Story Ideas/:series
//   novels/series/:series/books/:book         (e.g. a deeper tree)

export type Scope = { series: string | null; book: string | null };
export type ScopePattern = string[];

export const DEFAULT_SCOPE_PATTERNS = "Books/:series/:book,Story Ideas/:series";

export function parseScopePatterns(spec: string): ScopePattern[] {
  return spec
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) =>
      p
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, "")
        .split("/")
        .filter(Boolean)
    )
    .filter((segs) => segs.length > 0);
}

const DEFAULT_PATTERNS = parseScopePatterns(DEFAULT_SCOPE_PATTERNS);

export function scopeFromPath(
  relPath: string,
  patterns: ScopePattern[] = DEFAULT_PATTERNS
): Scope {
  const parts = relPath.split(/[/\\]/).filter(Boolean);
  for (const pat of patterns) {
    if (pat.length > parts.length) continue;
    let series: string | null = null;
    let book: string | null = null;
    let ok = true;
    for (let i = 0; i < pat.length; i++) {
      const seg = pat[i]!;
      const val = parts[i]!;
      if (seg === ":series") series = val;
      else if (seg === ":book") book = val;
      else if (seg.toLowerCase() !== val.toLowerCase()) {
        ok = false;
        break;
      }
    }
    if (ok && (series !== null || book !== null)) return { series, book };
  }
  return { series: null, book: null };
}
