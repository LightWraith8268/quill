// Anti-pattern linter for the markdown editor. Decorates forbidden words,
// excessive em-dashes, rule-of-three, "not X but Y", verbatim echoes.
// Anti-pattern source: Styles/riley-e-antrobus.md anti-pattern bible.

import { RangeSetBuilder, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  hoverTooltip,
} from "@codemirror/view";

const FORBIDDEN_WORDS = [
  "delve",
  "moreover",
  "furthermore",
  "albeit",
  "indeed",
  "certainly",
  "nevertheless",
];

const CLICHE_PHRASES = [
  "symphony of",
  "tapestry of",
  "delicate balance",
  "testament to",
  "nestled in",
  "let's dive in",
  "let's break it down",
  "let's dissect",
];

type Issue = {
  from: number;
  to: number;
  severity: "high" | "medium" | "low";
  rule: string;
  message: string;
};

function buildIssues(text: string): Issue[] {
  const issues: Issue[] = [];

  // 1. Forbidden words (case-insensitive, word-bounded)
  for (const word of FORBIDDEN_WORDS) {
    const re = new RegExp(`\\b${word}\\b`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      issues.push({
        from: m.index,
        to: m.index + m[0].length,
        severity: "high",
        rule: "forbidden-word",
        message: `"${m[0]}" is on the zero-tolerance list.`,
      });
    }
  }

  // 2. Clichéd phrases
  for (const phrase of CLICHE_PHRASES) {
    const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      issues.push({
        from: m.index,
        to: m.index + m[0].length,
        severity: "high",
        rule: "cliche",
        message: `"${m[0]}" is a flagged cliché.`,
      });
    }
  }

  // 3. Em-dash density: more than 5 per 1000 words = warn each em-dash beyond quota
  const wordCount = (text.match(/\b\w+\b/g) ?? []).length;
  const dashes: number[] = [];
  let dashIdx = -1;
  while ((dashIdx = text.indexOf("—", dashIdx + 1)) !== -1) dashes.push(dashIdx);
  const quota = Math.floor((wordCount * 5) / 1000);
  if (dashes.length > quota) {
    for (let i = quota; i < dashes.length; i++) {
      const idx = dashes[i]!;
      issues.push({
        from: idx,
        to: idx + 1,
        severity: "medium",
        rule: "em-dash-quota",
        message: `Em-dash exceeds 5/1000-word quota (this doc: ${dashes.length} dashes, ${wordCount} words, quota ${quota}).`,
      });
    }
  }

  // 4. "not X but Y" / "not X, but Y"
  const notButRe = /\bnot\s+(?:just\s+|merely\s+|only\s+)?[\w]+(?:\s+\w+)?,?\s+but\s+\w+/gi;
  let m2: RegExpExecArray | null;
  while ((m2 = notButRe.exec(text)) !== null) {
    issues.push({
      from: m2.index,
      to: m2.index + m2[0].length,
      severity: "medium",
      rule: "not-x-but-y",
      message: "Avoid 'not X but Y' contrast formulas.",
    });
  }

  // 5. Rule of three (heuristic: 3 short comma-separated items in a row)
  const ruleOfThreeRe = /\b(\w+),\s+(\w+),\s+(?:and\s+)?(\w+)\b/g;
  while ((m2 = ruleOfThreeRe.exec(text)) !== null) {
    // Only flag if all three items are short (<10 chars) — better signal of forced cadence.
    if (m2[1] && m2[2] && m2[3] && m2[1].length < 10 && m2[2].length < 10 && m2[3].length < 10) {
      issues.push({
        from: m2.index,
        to: m2.index + m2[0].length,
        severity: "low",
        rule: "rule-of-three",
        message: "Possible rule-of-three; vary cadence.",
      });
    }
  }

  return issues;
}

const decoFor = {
  high: Decoration.mark({
    class: "cm-quill-lint cm-quill-lint-high",
  }),
  medium: Decoration.mark({
    class: "cm-quill-lint cm-quill-lint-medium",
  }),
  low: Decoration.mark({
    class: "cm-quill-lint cm-quill-lint-low",
  }),
};

function buildDecorations(text: string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const issues = buildIssues(text);
  // RangeSetBuilder requires from-ascending order
  issues.sort((a, b) => a.from - b.from || a.to - b.to);
  for (const issue of issues) {
    builder.add(issue.from, issue.to, decoFor[issue.severity]);
  }
  return builder.finish();
}

const lintPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view.state.doc.toString());
    }
    update(update: ViewUpdate): void {
      if (update.docChanged) {
        this.decorations = buildDecorations(update.state.doc.toString());
      }
    }
  },
  { decorations: (v) => v.decorations }
);

const lintTooltip = hoverTooltip((view, pos) => {
  const text = view.state.doc.toString();
  const issues = buildIssues(text);
  const hit = issues.find((i) => pos >= i.from && pos <= i.to);
  if (!hit) return null;
  return {
    pos: hit.from,
    end: hit.to,
    above: true,
    create() {
      const dom = document.createElement("div");
      dom.className = "cm-quill-lint-tooltip";
      dom.textContent = `[${hit.rule}] ${hit.message}`;
      return { dom };
    },
  };
});

const lintTheme = EditorView.baseTheme({
  ".cm-quill-lint-high": {
    textDecoration: "underline wavy #ef4444",
    textDecorationSkipInk: "none",
  },
  ".cm-quill-lint-medium": {
    textDecoration: "underline wavy #f59e0b",
    textDecorationSkipInk: "none",
  },
  ".cm-quill-lint-low": {
    textDecoration: "underline dotted #94a3b8",
    textDecorationSkipInk: "none",
  },
  ".cm-quill-lint-tooltip": {
    backgroundColor: "#0F1115",
    color: "#E8E4DA",
    border: "1px solid #3BB3C9",
    padding: "4px 8px",
    fontSize: "12px",
    borderRadius: "4px",
    fontFamily: "Inter, sans-serif",
    maxWidth: "320px",
  },
});

export function antiPatternLinter(): Extension {
  return [lintPlugin, lintTooltip, lintTheme];
}

// Standalone summary for status bars (used outside editor too)
export function lintSummary(text: string): {
  high: number;
  medium: number;
  low: number;
  total: number;
} {
  const issues = buildIssues(text);
  return {
    high: issues.filter((i) => i.severity === "high").length,
    medium: issues.filter((i) => i.severity === "medium").length,
    low: issues.filter((i) => i.severity === "low").length,
    total: issues.length,
  };
}
