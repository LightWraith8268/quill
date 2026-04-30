// Vault path citation detection for chat messages.
//
// Matches qualified vault paths (e.g. `Books/Warborn Protocols/Manuscript.md`)
// inside arbitrary chat text so the markdown renderer can wrap them as links.
// Bare filenames (`CHARACTER_BIBLE.md` with no folder prefix) are intentionally
// NOT matched — they are ambiguous across series.

const VAULT_ROOTS = ["Books", "Story Ideas", "Uncensored", "Styles"];

// Build alternation, escaping the space in "Story Ideas".
const ROOTS_ALT = VAULT_ROOTS.map((r) => r.replace(/ /g, "\\ ")).join("|");

// The path body: anything that isn't whitespace or one of the closing
// boundary characters, ending in `.md`. The path itself can contain spaces
// (vault folders often do), so we stop at characters that terminate citations:
// closing brackets/parens/quotes/backticks, or another whitespace run after `.md`.
//
// Strategy: greedy match for non-terminator chars, anchored to `.md` at end.
// We use a non-capturing global regex and rely on a manual scan for offsets so
// the boundary char before the path is NOT included in the returned span.
export const VAULT_PATH_RE = new RegExp(
  // Group 1: optional leading boundary (start, whitespace, opener). We use a
  // lookbehind alternative for browsers that support it; fall back to capturing.
  `(^|[\\s(\\\`"'\\[])((?:${ROOTS_ALT})\\/[^\\s)\\\`"'\\]]*?\\.md)`,
  "g",
);

export type Citation = {
  start: number;
  end: number;
  path: string;
};

// Scan `text` for vault path citations. Offsets refer to the path text only
// (not the leading boundary char captured by the regex).
export function findCitations(text: string): Citation[] {
  const out: Citation[] = [];
  const re = new RegExp(VAULT_PATH_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const leading = match[1] ?? "";
    const path = match[2] ?? "";
    if (!path) continue;
    const start = match.index + leading.length;
    const end = start + path.length;
    out.push({ start, end, path });
  }
  return out;
}

// Cross-component navigation: ChatPanel's MarkdownView fires this when the user
// clicks a vault citation; App.tsx listens, switches the tab, and stashes the
// requested path in localStorage for VaultBrowser to pick up on next mount.
export const VAULT_NAV_EVENT = "quill:navigate-vault";
export const VAULT_PENDING_KEY = "quill.vaultPending";

export function goToVaultPath(path: string): void {
  try {
    localStorage.setItem(VAULT_PENDING_KEY, path);
  } catch {
    // localStorage may be unavailable; event still dispatches.
  }
  window.dispatchEvent(new CustomEvent(VAULT_NAV_EVENT, { detail: { path } }));
}
