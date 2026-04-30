// Renders the structured Continuity Sweep payload as a click-through issue list.
//
// Extracts the FIRST ```json fenced block from the assistant's prose, parses it,
// and validates the rough shape against the continuity_sweep outputSchema. If
// parsing fails or the shape is wrong, renders nothing — caller falls back to
// showing the raw prose. Robust to: missing block, trailing text, single-line
// fences, leading "json" / "JSON" tag variants, BOM, and stray backticks inside
// strings (uses balanced ``` matching, not greedy-to-EOF).

import { goToVaultPath } from "../citations.ts";

const CATEGORIES = ["age", "fact", "voice", "terminology", "timeline", "other"] as const;
const SEVERITIES = ["high", "medium", "low"] as const;

type Category = (typeof CATEGORIES)[number];
type Severity = (typeof SEVERITIES)[number];

export type SweepIssue = {
  category: Category;
  severity: Severity;
  file: string;
  line: number | null;
  problem: string;
  fix: string;
};

export type SweepReportData = {
  summary: string;
  issues: SweepIssue[];
};

type Props = {
  rawAssistantMessage: string;
  onJumpToFile?: (path: string, line?: number | null) => void;
};

// Extract first ```json fenced block. Tolerates:
//   ```json\n{...}\n```
//   ```JSON ... ```
//   ``` { ... } ```  (no language tag, fallback)
// Returns the inner JSON string, or null.
export function extractJsonBlock(text: string): string | null {
  if (!text) return null;
  // Prefer json-tagged fences first.
  const tagged = /```\s*(?:json|JSON)\s*\n([\s\S]*?)\n?```/m.exec(text);
  if (tagged && tagged[1]) return tagged[1].trim();
  // Fallback: any fenced block whose contents start with `{`.
  const generic = /```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```/m;
  let m: RegExpExecArray | null;
  const re = new RegExp(generic.source, "gm");
  while ((m = re.exec(text)) !== null) {
    const body = (m[1] ?? "").trim();
    if (body.startsWith("{")) return body;
  }
  // Last-resort: find a top-level {...} block at end of text.
  const lastBrace = text.lastIndexOf("{");
  if (lastBrace !== -1) {
    const tail = text.slice(lastBrace);
    // crude balance check
    let depth = 0;
    let end = -1;
    let inStr = false;
    let escape = false;
    for (let i = 0; i < tail.length; i++) {
      const ch = tail[i];
      if (inStr) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end > 0) return tail.slice(0, end);
  }
  return null;
}

export function parseSweepReport(text: string): SweepReportData | null {
  const block = extractJsonBlock(text);
  if (!block) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.summary !== "string") return null;
  if (!Array.isArray(obj.issues)) return null;
  const issues: SweepIssue[] = [];
  for (const raw of obj.issues) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const category = (CATEGORIES as readonly string[]).includes(r.category as string)
      ? (r.category as Category)
      : "other";
    const severity = (SEVERITIES as readonly string[]).includes(r.severity as string)
      ? (r.severity as Severity)
      : "low";
    if (typeof r.file !== "string" || !r.file) continue;
    if (typeof r.problem !== "string") continue;
    if (typeof r.fix !== "string") continue;
    const line =
      typeof r.line === "number" && Number.isFinite(r.line) ? Math.trunc(r.line) : null;
    issues.push({
      category,
      severity,
      file: r.file,
      line,
      problem: r.problem,
      fix: r.fix,
    });
  }
  return { summary: obj.summary, issues };
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

const SEVERITY_BADGE: Record<Severity, string> = {
  high: "bg-red-200 text-red-900 dark:bg-red-900/60 dark:text-red-100",
  medium: "bg-amber-200 text-amber-900 dark:bg-amber-900/60 dark:text-amber-100",
  low: "bg-blue-200 text-blue-900 dark:bg-blue-900/60 dark:text-blue-100",
};

export function SweepReport({ rawAssistantMessage, onJumpToFile }: Props) {
  const data = parseSweepReport(rawAssistantMessage);
  if (!data) return null;

  const sorted = [...data.issues].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  );

  const handleJump = (file: string, line: number | null) => {
    if (onJumpToFile) onJumpToFile(file, line);
    else goToVaultPath(file);
  };

  return (
    <div className="space-y-3">
      <div className="card bg-paper/60 dark:bg-bg/60">
        <div className="text-xs uppercase tracking-wide text-tealBright mb-1">
          Continuity Sweep — Summary
        </div>
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{data.summary}</p>
      </div>

      <div className="card">
        <div className="flex items-baseline mb-2">
          <h3 className="font-display text-lg">
            Issues ({sorted.length})
          </h3>
          <span className="text-xs text-muted ml-2">click file to jump in Vault</span>
        </div>
        {sorted.length === 0 ? (
          <p className="text-sm text-muted">
            No continuity issues detected. Sweep clean.
          </p>
        ) : (
          <ul className="divide-y divide-muted/20">
            {sorted.map((issue, idx) => (
              <li key={idx} className="py-3 first:pt-0 last:pb-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`text-xs font-mono px-2 py-0.5 rounded uppercase ${SEVERITY_BADGE[issue.severity]}`}
                  >
                    {issue.severity}
                  </span>
                  <span className="text-xs px-1.5 py-0.5 border border-muted/40 rounded font-mono">
                    {issue.category}
                  </span>
                  <button
                    onClick={() => handleJump(issue.file, issue.line)}
                    className="text-sm font-mono text-tealBright hover:underline truncate text-left"
                    title={issue.file + (issue.line != null ? `:${issue.line}` : "")}
                  >
                    {issue.file}
                    {issue.line != null && <span className="text-muted">:{issue.line}</span>}
                  </button>
                </div>
                <div className="text-sm">
                  <span className="text-muted">Problem: </span>
                  {issue.problem}
                </div>
                <div className="text-sm">
                  <span className="text-muted">Fix: </span>
                  {issue.fix}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
