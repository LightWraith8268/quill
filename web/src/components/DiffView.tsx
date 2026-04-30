// Unified line-diff viewer for snapshot comparisons.

import { useMemo, useState } from "react";
import { diffLines, type Change } from "diff";

interface DiffSide {
  label: string;
  content: string;
}

interface DiffViewProps {
  left: DiffSide;
  right: DiffSide;
}

interface RenderedRow {
  kind: "added" | "removed" | "context" | "collapsed";
  text?: string;
  collapsedLines?: string[];
  key: string;
}

const COLLAPSE_THRESHOLD = 6;

function buildRows(changes: Change[]): RenderedRow[] {
  const rows: RenderedRow[] = [];
  let rowIndex = 0;
  for (const change of changes) {
    const lines = change.value.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    if (change.added) {
      for (const line of lines) {
        rows.push({ kind: "added", text: line, key: `r${rowIndex++}` });
      }
    } else if (change.removed) {
      for (const line of lines) {
        rows.push({ kind: "removed", text: line, key: `r${rowIndex++}` });
      }
    } else {
      if (lines.length > COLLAPSE_THRESHOLD) {
        // Show first 2 + collapsed middle + last 2
        const head = lines.slice(0, 2);
        const tail = lines.slice(-2);
        const middle = lines.slice(2, -2);
        for (const line of head) {
          rows.push({ kind: "context", text: line, key: `r${rowIndex++}` });
        }
        rows.push({
          kind: "collapsed",
          collapsedLines: middle,
          key: `r${rowIndex++}`,
        });
        for (const line of tail) {
          rows.push({ kind: "context", text: line, key: `r${rowIndex++}` });
        }
      } else {
        for (const line of lines) {
          rows.push({ kind: "context", text: line, key: `r${rowIndex++}` });
        }
      }
    }
  }
  return rows;
}

export function DiffView({ left, right }: DiffViewProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const rows = useMemo(() => {
    const changes = diffLines(left.content, right.content);
    return buildRows(changes);
  }, [left.content, right.content]);

  const stats = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const row of rows) {
      if (row.kind === "added") added += 1;
      else if (row.kind === "removed") removed += 1;
    }
    return { added, removed };
  }, [rows]);

  const toggleExpand = (key: string) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const leftBytes = new TextEncoder().encode(left.content).length;
  const rightBytes = new TextEncoder().encode(right.content).length;

  return (
    <div className="card bg-paper/60 dark:bg-bg/60 max-h-[32rem] overflow-auto">
      <div className="flex flex-wrap gap-3 items-baseline mb-2 text-xs font-mono">
        <span className="text-red-700 dark:text-red-300">
          − {left.label}{" "}
          <span className="text-muted">({(leftBytes / 1024).toFixed(1)} KB)</span>
        </span>
        <span className="text-green-700 dark:text-green-300">
          + {right.label}{" "}
          <span className="text-muted">({(rightBytes / 1024).toFixed(1)} KB)</span>
        </span>
        <span className="text-muted ml-auto">
          +{stats.added} / −{stats.removed}
        </span>
      </div>
      <div className="font-mono text-xs leading-relaxed">
        {rows.map((row) => {
          if (row.kind === "collapsed") {
            const isOpen = expanded.has(row.key);
            const collapsedLines = row.collapsedLines ?? [];
            if (isOpen) {
              return (
                <div key={row.key}>
                  <button
                    onClick={() => toggleExpand(row.key)}
                    className="w-full text-left text-muted italic px-2 py-0.5 hover:bg-muted/10"
                  >
                    … collapse {collapsedLines.length} unchanged lines
                  </button>
                  {collapsedLines.map((line, i) => (
                    <div
                      key={`${row.key}-${i}`}
                      className="text-muted whitespace-pre-wrap break-all px-2"
                    >
                      <span className="select-none mr-2">·</span>
                      {line}
                    </div>
                  ))}
                </div>
              );
            }
            return (
              <button
                key={row.key}
                onClick={() => toggleExpand(row.key)}
                className="w-full text-left text-muted italic px-2 py-0.5 hover:bg-muted/10"
              >
                … {collapsedLines.length} lines unchanged (click to expand)
              </button>
            );
          }
          if (row.kind === "added") {
            return (
              <div
                key={row.key}
                className="bg-green-100 dark:bg-green-900/30 text-green-900 dark:text-green-200 whitespace-pre-wrap break-all px-2"
              >
                <span className="select-none mr-2">+</span>
                {row.text}
              </div>
            );
          }
          if (row.kind === "removed") {
            return (
              <div
                key={row.key}
                className="bg-red-100 dark:bg-red-900/30 text-red-900 dark:text-red-200 whitespace-pre-wrap break-all px-2"
              >
                <span className="select-none mr-2">−</span>
                {row.text}
              </div>
            );
          }
          return (
            <div
              key={row.key}
              className="text-muted whitespace-pre-wrap break-all px-2"
            >
              <span className="select-none mr-2">·</span>
              {row.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}
