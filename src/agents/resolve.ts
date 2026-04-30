// Cross-platform CLI binary resolver. On Windows: try .exe, .cmd, .ps1, then bare.
// On Unix: bare. Caches successful lookups.

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

const cache = new Map<string, string>();

function candidates(name: string): string[] {
  if (process.platform !== "win32") return [name];
  const exts = ["", ".exe", ".cmd", ".bat", ".ps1"];
  // Avoid duplicating an already-suffixed path
  if (/\.(exe|cmd|bat|ps1)$/i.test(name)) return [name];
  return exts.map((e) => name + e);
}

export function resolveBin(name: string): string {
  const cached = cache.get(name);
  if (cached) return cached;

  const PATH = process.env.PATH ?? "";
  const dirs = PATH.split(delimiter).filter(Boolean);

  for (const dir of dirs) {
    for (const cand of candidates(name)) {
      const p = join(dir, cand);
      if (existsSync(p)) {
        cache.set(name, p);
        return p;
      }
    }
  }
  // Fallback to bare name; spawn will surface the error.
  return name;
}
