// Specialized writing workflows. Each workflow defines:
// - a recommended agent (locked at the API layer)
// - a set of input fields (rendered as form in UI)
// - a template that builds the chat prompt from inputs
//
// Workflows route through the standard chat pipeline (runChat) so they get
// full RAG context, style, and history persistence.

import type { AgentName } from "./agents/router.ts";

export type WorkflowField = {
  name: string;
  label: string;
  kind: "text" | "textarea" | "number" | "select";
  required?: boolean;
  default?: string | number;
  placeholder?: string;
  options?: { value: string; label: string }[];
  rows?: number;
};

export type WorkflowDef = {
  id: string;
  title: string;
  description: string;
  agent: AgentName;
  fields: WorkflowField[];
  /** Build the chat message that gets sent. */
  buildPrompt: (inputs: Record<string, string>) => string;
};

export const WORKFLOWS: WorkflowDef[] = [
  {
    id: "continuity_sweep",
    title: "Continuity Sweep",
    description:
      "Bulk-read manuscripts and check against canon (character ages, established facts, voice, terminology, timeline). Best with Gemini's long context.",
    agent: "gemini",
    fields: [
      {
        name: "scope",
        label: "Scope",
        kind: "select",
        required: true,
        default: "this_story",
        options: [
          { value: "this_story", label: "This story only" },
          { value: "this_series", label: "Entire series" },
          { value: "all_books", label: "All books in the vault" },
        ],
      },
      {
        name: "focus",
        label: "Focus areas (optional)",
        kind: "textarea",
        rows: 3,
        placeholder:
          "e.g. character ages, Vesper's no-contractions rule, Network terminology capitalization",
      },
    ],
    buildPrompt: (i) => {
      const scopeLabel: Record<string, string> = {
        this_story: "this story (active story folder)",
        this_series: "the entire active series",
        all_books: "all books in the vault",
      };
      const scope = scopeLabel[i.scope ?? "this_story"];
      const focus = i.focus?.trim()
        ? `\n\nFocus your sweep on: ${i.focus.trim()}`
        : "";
      return [
        `CONTINUITY SWEEP — ${scope}.`,
        ``,
        `Read every manuscript file under the chosen scope. Compare each against:`,
        `1. The active style profile (anti-patterns, voice rules, AI-markup conventions).`,
        `2. The series CHARACTER_BIBLE.md and any world bibles in context.`,
        `3. Established lore from the RAG retrieval.`,
        ``,
        `Flag any contradictions in: character ages and arc-state per book, established facts, voice consistency (Vesper / Zeta speech rules, Riko register progression, etc.), terminology and capitalization (Network, Ascendant, Wake State, Community), timeline.`,
        ``,
        `For each issue, output one line in this format:`,
        `\`<file>:<line>\` — <issue> — <proposed fix>`,
        ``,
        `If you find no contradictions in a category, say so explicitly so I know it was checked. Do not rewrite — diagnose.${focus}`,
      ].join("\n");
    },
  },
  {
    id: "scene_drafter",
    title: "Scene Drafter",
    description:
      "Draft a scene in the active style + genre overlays + series voice. Best with Claude.",
    agent: "claude",
    fields: [
      {
        name: "goal",
        label: "Scene goal / dramatic question",
        kind: "textarea",
        rows: 2,
        required: true,
        placeholder:
          "e.g. Riko admits to Kira that she's been avoiding the Cradle since the conversion",
      },
      {
        name: "pov",
        label: "POV character",
        kind: "text",
        required: true,
        placeholder: "Riko",
      },
      {
        name: "location",
        label: "Location / setting",
        kind: "text",
        placeholder: "Phantom Veil observation deck",
      },
      {
        name: "present",
        label: "Characters present (comma-separated)",
        kind: "text",
        placeholder: "Riko, Kira, Vesper (private channel)",
      },
      {
        name: "words",
        label: "Target word count",
        kind: "number",
        default: 800,
      },
      {
        name: "notes",
        label: "Notes / constraints",
        kind: "textarea",
        rows: 3,
        placeholder:
          "anything required: anchor beats, callbacks, motifs, what NOT to do",
      },
    ],
    buildPrompt: (i) => {
      const lines: string[] = [
        `SCENE DRAFT REQUEST.`,
        ``,
        `Apply the active style profile rigorously. Verify Vesper/Zeta speech convention if either appears. Respect anti-patterns. End on forward pull. Open with concrete orientation in 1–2 sentences.`,
        ``,
        `Scene goal: ${i.goal ?? ""}`,
      ];
      if (i.pov) lines.push(`POV: ${i.pov}`);
      if (i.location) lines.push(`Location: ${i.location}`);
      if (i.present) lines.push(`Characters present: ${i.present}`);
      if (i.words) lines.push(`Target length: ~${i.words} words.`);
      if (i.notes?.trim()) lines.push(``, `Notes:`, i.notes.trim());
      lines.push(
        ``,
        `Begin the scene now. No preamble, no commentary. Prose only.`
      );
      return lines.join("\n");
    },
  },
  {
    id: "structural_critique",
    title: "Structural Critique",
    description:
      "Diagnose structure of a scene/chapter (shape, pacing, agency, escalation). Best with Codex.",
    agent: "codex",
    fields: [
      {
        name: "text",
        label: "Scene or chapter text",
        kind: "textarea",
        rows: 12,
        required: true,
        placeholder: "Paste the scene/chapter here.",
      },
      {
        name: "focus",
        label: "Specific concerns (optional)",
        kind: "textarea",
        rows: 2,
        placeholder: "e.g. middle sags, opening doesn't orient, ending feels flat",
      },
    ],
    buildPrompt: (i) => {
      const focus = i.focus?.trim() ? `\n\nUser concerns: ${i.focus.trim()}` : "";
      return [
        `STRUCTURAL CRITIQUE — diagnose, do not rewrite.`,
        ``,
        `Evaluate the following scene/chapter on:`,
        `- Scene shape (goal → resistance → choice; arrival/departure stakes change)`,
        `- Opening orientation (anchored in 1–2 sentences? who/where/goal?)`,
        `- Pacing (where does the line lengthen? where is breath needed?)`,
        `- Character agency (whose decision drives the turn?)`,
        `- Escalation pattern (does each beat raise stakes or repeat them?)`,
        `- Closing forward-pull (does it propel into the next scene?)`,
        `- Style / anti-pattern adherence per the active style profile`,
        ``,
        `Identify what is load-bearing vs filler. Then propose 1–3 surgical structural fixes — minimum-change interventions. Cite line numbers / specific phrases when possible.${focus}`,
        ``,
        `=== SCENE / CHAPTER ===`,
        i.text ?? "",
      ].join("\n");
    },
  },
];

export function listWorkflows() {
  return WORKFLOWS.map((w) => ({
    id: w.id,
    title: w.title,
    description: w.description,
    agent: w.agent,
    fields: w.fields,
  }));
}

export function getWorkflow(id: string): WorkflowDef | null {
  return WORKFLOWS.find((w) => w.id === id) ?? null;
}
