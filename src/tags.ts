// Tag a vault-relative path against include globs from config.
// Glob support: ** = any depth, * = within segment. Case-insensitive on Windows.

import { splitGlobs, type Config } from "./config.ts";

function globToRegex(glob: string): RegExp {
  const norm = glob.replace(/\\/g, "/");
  let re = "^";
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i]!;
    if (c === "*") {
      if (norm[i + 1] === "*") {
        re += ".*";
        i++;
        if (norm[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if ("\\^$.|?+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re, "i");
}

function matchAny(rel: string, globs: string[]): boolean {
  const norm = rel.replace(/\\/g, "/");
  return globs.some((g) => globToRegex(g).test(norm));
}

export type Tag = "style" | "lore" | "uncensored";

export function tagsFor(relPath: string, cfg: Config): Tag[] {
  const tags: Tag[] = [];
  if (matchAny(relPath, splitGlobs(cfg.STYLE_INCLUDE))) tags.push("style");
  if (matchAny(relPath, splitGlobs(cfg.LORE_INCLUDE))) tags.push("lore");
  if (matchAny(relPath, splitGlobs(cfg.UNCENSORED_INCLUDE))) tags.push("uncensored");
  return tags;
}
