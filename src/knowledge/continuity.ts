// Continuity checking: flag where a draft contradicts the series' canon.
// A fast heuristic (antonym/negation against canon facts) plus an accurate LLM
// audit. Returns structured issues for the UI / CLI.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { DB } from "../db.ts";
import { claudeOnce } from "../agents/claude.ts";

export type ContinuityIssue = {
  severity: "high" | "medium" | "low";
  entity: string | null;
  claim: string; // what the draft says
  canon: string; // the canon it conflicts with
  suggestion: string;
  source: "llm" | "heuristic";
};

type CanonFactRow = { claim: string; canon_weight: string; ename: string | null };

const ANTONYMS: [string, string][] = [
  ["alive", "dead"],
  ["living", "dead"],
  ["male", "female"],
  ["young", "old"],
  ["tall", "short"],
  ["rich", "poor"],
  ["human", "machine"],
  ["awake", "asleep"],
  ["enemy", "ally"],
  ["mortal", "immortal"],
];

function wordsOf(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3)
  );
}

// High-precision heuristic: when the draft mentions a canon fact's entity AND
// uses the antonym of a word in that fact, flag a likely contradiction. The LLM
// pass handles the subtler cases.
function heuristicIssues(facts: CanonFactRow[], text: string): ContinuityIssue[] {
  const issues: ContinuityIssue[] = [];
  const tw = wordsOf(text);
  const lower = text.toLowerCase();
  for (const f of facts) {
    const ent = f.ename;
    if (ent && !lower.includes(ent.toLowerCase())) continue;
    const fw = wordsOf((ent ?? "") + " " + f.claim);
    for (const [a, b] of ANTONYMS) {
      const flip =
        (fw.has(a) && tw.has(b)) || (fw.has(b) && tw.has(a));
      if (flip) {
        issues.push({
          severity: "high",
          entity: ent,
          source: "heuristic",
          claim: `draft uses "${tw.has(a) ? a : b}"`,
          canon: f.claim,
          suggestion: `Canon says "${f.claim}" — reconcile the contradiction.`,
        });
        break;
      }
    }
  }
  return issues;
}

const LLM_SYS = `You are a continuity checker for a novel. Given CANON facts and a DRAFT, find places where the draft contradicts canon. Output STRICT JSON only:
{ "issues": [ { "severity": "high|medium|low", "entity": "name or null", "claim": "what the draft says", "canon": "the canon it conflicts with", "suggestion": "how to fix" } ] }
Only report genuine contradictions with HARD or SOFT canon. If there are none, return { "issues": [] }.`;

async function llmIssues(
  cfg: Config,
  facts: CanonFactRow[],
  text: string
): Promise<ContinuityIssue[]> {
  if (facts.length === 0) return [];
  const canon = facts
    .map((f) => `- [${f.canon_weight}] ${f.ename ? f.ename + ": " : ""}${f.claim}`)
    .join("\n");
  const prompt = `${LLM_SYS}\n\n=== CANON ===\n${canon}\n\n=== DRAFT ===\n${text.slice(0, 80_000)}`;
  const out = await claudeOnce(prompt, { cwd: cfg.VAULT_PATH });
  let t = out.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) t = fence[1].trim();
  if (!t.startsWith("{")) {
    const i = t.indexOf("{");
    const j = t.lastIndexOf("}");
    if (i >= 0 && j > i) t = t.slice(i, j + 1);
  }
  try {
    const parsed = JSON.parse(t) as {
      issues?: Array<{
        severity?: string;
        entity?: string | null;
        claim?: string;
        canon?: string;
        suggestion?: string;
      }>;
    };
    return (parsed.issues ?? []).map((x) => ({
      severity: x.severity === "high" || x.severity === "low" ? x.severity : "medium",
      entity: x.entity ?? null,
      claim: String(x.claim ?? ""),
      canon: String(x.canon ?? ""),
      suggestion: String(x.suggestion ?? ""),
      source: "llm" as const,
    }));
  } catch {
    return [];
  }
}

export async function checkContinuity(
  cfg: Config,
  db: DB,
  opts: { series: string | null; text: string; useLlm?: boolean }
): Promise<ContinuityIssue[]> {
  const facts = db
    .query<CanonFactRow, [string | null, string | null]>(
      `SELECT f.claim, f.canon_weight, e.name AS ename
       FROM kb_facts f LEFT JOIN kb_entities e ON e.id = f.entity_id
       WHERE (f.series IS ? OR f.series = ?) AND f.canon_weight IN ('hard_canon','soft_canon')`
    )
    .all(opts.series, opts.series);

  const heur = heuristicIssues(facts, opts.text);
  if (opts.useLlm === false) return heur;

  const llm = await llmIssues(cfg, facts, opts.text);
  const seen = new Set(heur.map((i) => `${i.entity}∷${i.canon}`));
  return [...heur, ...llm.filter((i) => !seen.has(`${i.entity}∷${i.canon}`))];
}

export async function checkContinuityFile(
  cfg: Config,
  db: DB,
  opts: { series: string | null; file: string; useLlm?: boolean }
): Promise<ContinuityIssue[]> {
  const text = await readFile(join(cfg.VAULT_PATH, opts.file), "utf-8");
  return checkContinuity(cfg, db, { series: opts.series, text, useLlm: opts.useLlm });
}
