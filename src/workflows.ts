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
  /** Optional JSON schema describing structured response payload (for UI rendering). */
  outputSchema?: object;
};

const CONTINUITY_SWEEP_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["age", "fact", "voice", "terminology", "timeline", "other"],
          },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          file: { type: "string" },
          line: { type: ["integer", "null"] },
          problem: { type: "string" },
          fix: { type: "string" },
        },
        required: ["category", "severity", "file", "problem", "fix"],
      },
    },
  },
  required: ["summary", "issues"],
} as const;

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
        `Write your normal diagnostic prose first — narrative explanation of what you checked and what you found. Do not rewrite — diagnose only.${focus}`,
        ``,
        `=== STRUCTURED OUTPUT REQUIREMENT ===`,
        ``,
        `At the very end of your response, after all prose, output a SINGLE fenced JSON code block matching this exact schema:`,
        ``,
        "```json",
        JSON.stringify(CONTINUITY_SWEEP_OUTPUT_SCHEMA, null, 2),
        "```",
        ``,
        `The JSON block must be valid and parseable. Shape:`,
        ``,
        "```json",
        `{`,
        `  "summary": "one-paragraph overview of what was checked and the headline findings",`,
        `  "issues": [`,
        `    {`,
        `      "category": "age" | "fact" | "voice" | "terminology" | "timeline" | "other",`,
        `      "severity": "high" | "medium" | "low",`,
        `      "file": "Books/Series/Book 1/Chapter 03.md",`,
        `      "line": 142,`,
        `      "problem": "Riko is described as 19, but CHARACTER_BIBLE.md sets her age at 21 in this book.",`,
        `      "fix": "Change to 21, or update bible if intentional."`,
        `    }`,
        `  ]`,
        `}`,
        "```",
        ``,
        `Rules for the JSON block:`,
        `- Use the EXACT category and severity enum values listed above (lowercase).`,
        `- "file" must be the vault-relative path (e.g. "Books/Series/Book 1/Chapter 03.md").`,
        `- "line" is the integer line number, or null if not applicable.`,
        `- "problem" and "fix" are short prose strings.`,
        `- If you found zero issues, "issues" must be an empty array [].`,
        `- Output exactly ONE JSON code block. Any text outside the block is treated as narrative prose only.`,
      ].join("\n");
    },
    outputSchema: CONTINUITY_SWEEP_OUTPUT_SCHEMA,
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
  {
    id: "bible_update_proposal",
    title: "Bible Update Proposal",
    description:
      "After a chapter is drafted, propose additions to the series CHARACTER_BIBLE / style overlays for newly earned beats, lexicon, motifs. Best with Claude.",
    agent: "claude",
    fields: [
      {
        name: "chapter_text",
        label: "Chapter / scene text",
        kind: "textarea",
        rows: 14,
        required: true,
        placeholder: "Paste the just-drafted chapter or scene here.",
      },
      {
        name: "current_bible",
        label: "Current bible content (optional, paste relevant excerpts)",
        kind: "textarea",
        rows: 6,
        placeholder:
          "Paste the relevant character / style sections so I can compare. Skip for a one-shot suggestion.",
      },
      {
        name: "characters",
        label: "Characters featured (comma-separated)",
        kind: "text",
        placeholder: "Riko, Kira, Vesper",
      },
    ],
    buildPrompt: (i): string => {
      const lines: (string | undefined)[] = [
        `BIBLE UPDATE PROPOSAL — diagnose, do not rewrite the bible.`,
        ``,
        `Read the chapter below. Compare against the active style profile, the series CHARACTER_BIBLE.md (in context), and the bible excerpts the user pasted. Identify ONLY items that:`,
        `- Survived the drafting (not provisional / draft-only),`,
        `- Are NEW (not already present in the active bible / style overlays),`,
        `- Are load-bearing enough to deserve canonization.`,
        ``,
        `Categories to scan:`,
        `1. **Earned voice beats** per character (e.g., a tic landed, a register shifted, a callback solidified).`,
        `2. **Lexicon entries** — in-world terms or specific phrasings now established.`,
        `3. **Motifs** that became load-bearing in the chapter.`,
        `4. **Relationship beats** — bond changes, register shifts, new shorthand.`,
        `5. **Constraints / costs** — system rules clarified or new failure modes shown.`,
        ``,
        i.characters?.trim() ? `Characters featured: ${i.characters.trim()}` : ``,
        ``,
        `Output a structured Markdown proposal with this exact shape:`,
        ``,
        `## Proposed additions`,
        `### Character: <Name>`,
        `- **Earned beat (Book N):** <one-line beat>`,
        `- **Voice rule:** <one-line rule, only if a NEW rule>`,
        ``,
        `### Series lexicon`,
        `- <new term> — <gloss>`,
        ``,
        `### Series motifs`,
        `- <motif> — <one-line description>`,
        ``,
        `### Relationship updates`,
        `- <Char A> ↔ <Char B>: <change>`,
        ``,
        `### System rules / constraints`,
        `- <rule>`,
        ``,
        `Skip any section with no new items. End with a 1-paragraph summary of how confident you are these survive future revision (high / medium / low).`,
        ``,
        `=== CHAPTER / SCENE ===`,
        i.chapter_text ?? "",
        ``,
        i.current_bible?.trim() ? `=== CURRENT BIBLE EXCERPTS ===\n${i.current_bible.trim()}` : ``,
      ];
      return lines.filter((l): l is string => typeof l === "string").join("\n");
    },
  },
  {
    id: "cover_blurb",
    title: "Cover Blurb / Log Line",
    description:
      "Generate back-cover copy, a 1-line log line, and 3 alt taglines from the manuscript. Best with Codex (sharp ad-copy register).",
    agent: "codex",
    fields: [
      { name: "manuscript_excerpt", label: "Manuscript opening (1-2 chapters)", kind: "textarea", rows: 12, required: true, placeholder: "Paste opening chapters" },
      { name: "comp_titles", label: "Comp titles (existing books in your tradition)", kind: "text", placeholder: "Ancillary Justice, A Memory Called Empire" },
      { name: "audience", label: "Target audience", kind: "text", placeholder: "adult sci-fi readers who like Becky Chambers + Ann Leckie" },
    ],
    buildPrompt: (i) => [
      `BACK-COVER COPY GENERATION.`,
      ``,
      `Given the manuscript opening, the comp titles, and the audience, write:`,
      `1. **Log line** — one sentence under 25 words. Hook + character + stakes.`,
      `2. **Back-cover blurb** — 150-200 words, 3 paragraphs (hook, character/stakes, twist+question), narrative present tense.`,
      `3. **Three alt taglines** — under 10 words each, distinct angles.`,
      ``,
      `Match the active style profile's voice. Avoid back-cover clichés ("In a world where…", "Now they must…", "discovers a secret"). Reference comp titles' tone, not their plots.`,
      ``,
      `=== AUDIENCE ===`,
      i.audience ?? "(unspecified)",
      ``,
      `=== COMP TITLES ===`,
      i.comp_titles ?? "(none)",
      ``,
      `=== MANUSCRIPT OPENING ===`,
      i.manuscript_excerpt ?? "",
    ].join("\n"),
  },
  {
    id: "query_letter",
    title: "Query Letter Draft",
    description:
      "Draft an industry-standard query letter for agents. Best with Codex.",
    agent: "codex",
    fields: [
      { name: "manuscript_excerpt", label: "Opening chapter(s)", kind: "textarea", rows: 12, required: true, placeholder: "Paste opening" },
      { name: "synopsis", label: "Brief synopsis (3-5 sentences) — full plot incl ending", kind: "textarea", rows: 5, required: true, placeholder: "What happens, including the ending — agents read this part." },
      { name: "title", label: "Title", kind: "text", required: true },
      { name: "word_count", label: "Word count (approximate)", kind: "number", default: 90000 },
      { name: "category", label: "Category / age", kind: "text", placeholder: "Adult Science Fiction" },
      { name: "comps", label: "Two comp titles (recent, US-published)", kind: "text", required: true, placeholder: "<Title> meets <Title>" },
      { name: "bio", label: "Author bio (1-2 sentences)", kind: "textarea", rows: 3, placeholder: "publishing credits, relevant background, geographic" },
    ],
    buildPrompt: (i) => [
      `QUERY LETTER DRAFT.`,
      ``,
      `Industry-standard format. Short. ~250-350 words total. Three blocks:`,
      `1. **Hook + housekeeping**: 1 paragraph naming title, word count, category, comp titles, and a one-line hook ("X meets Y in a story about…").`,
      `2. **Mini synopsis**: 1-2 paragraphs introducing protagonist, central conflict, stakes, the choice / turn at the heart of the book. Stop before the ending.`,
      `3. **Author bio**: 1 short paragraph, factual, no humble-bragging.`,
      ``,
      `Voice: confident but not boastful. No "I think you'll like this." No exclamation marks. No questions to the agent. Match the manuscript's voice in the hook.`,
      ``,
      `Title: ${i.title ?? "(unspecified)"}`,
      `Word count: ${i.word_count ?? "(unspecified)"}`,
      `Category: ${i.category ?? "(unspecified)"}`,
      `Comps: ${i.comps ?? "(unspecified)"}`,
      `Bio: ${i.bio ?? "(unspecified)"}`,
      ``,
      `=== SYNOPSIS (full plot, including ending — for the agent's reference, NOT to include in the letter) ===`,
      i.synopsis ?? "",
      ``,
      `=== MANUSCRIPT OPENING (voice reference) ===`,
      i.manuscript_excerpt ?? "",
    ].join("\n"),
  },
  {
    id: "sensitivity_pass",
    title: "Sensitivity / Inclusion Read",
    description:
      "Codex reads the chapter and flags potentially problematic representation, language, accessibility issues, or cultural appropriation. Diagnoses, doesn't moralize.",
    agent: "codex",
    fields: [
      { name: "text", label: "Chapter text", kind: "textarea", rows: 14, required: true },
      { name: "concerns", label: "Specific concerns (optional)", kind: "textarea", rows: 2, placeholder: "e.g. portrayal of disability, accent rendering, cultural references" },
    ],
    buildPrompt: (i) => [
      `SENSITIVITY / INCLUSION READ — diagnose, don't moralize.`,
      ``,
      `Read the text below. Flag specific concerns under these heads (skip if none):`,
      `1. **Identity representation** — characters from marginalized backgrounds rendered with depth or as ciphers/stereotypes?`,
      `2. **Language** — slurs (intentional or accidental), outdated terms, ableist phrasing.`,
      `3. **Cultural elements** — borrowed elements treated with research/context, or surface-level appropriation?`,
      `4. **Accessibility** — disability portrayed accurately, or as metaphor/inspiration porn?`,
      `5. **Power dynamics** — does the narrative challenge or reinforce them invisibly?`,
      ``,
      `For each issue, output: \`<location quote/line>\` — <issue> — <suggestion>. Suggestions, not commands.`,
      ``,
      `Skip moralizing. The author hired you for craft feedback, not lectures.${i.concerns?.trim() ? `\n\nUser concerns: ${i.concerns.trim()}` : ""}`,
      ``,
      `=== TEXT ===`,
      i.text ?? "",
    ].join("\n"),
  },
  {
    id: "brainstorm_room",
    title: "Brainstorm (no story context)",
    description:
      "Pure idea sandbox — no RAG, no style enforcement. Get loose with concepts, what-ifs, premises. Best with Codex (lateral thinking) or Gemini (broad).",
    agent: "codex",
    fields: [
      { name: "seed", label: "Seed", kind: "textarea", rows: 4, required: true, placeholder: "What if the AI realized it loved the protagonist before the protagonist did?" },
      { name: "count", label: "Number of distinct angles to generate", kind: "number", default: 5 },
    ],
    buildPrompt: (i) => [
      `IDEA SANDBOX — generate ${i.count ?? 5} distinct angles on the seed.`,
      ``,
      `Each angle should be substantively different (different genre, scale, register, character, or twist). Keep each to 2-4 sentences. Don't pick a winner — present them as parallel options. Then offer ONE wildcard angle that shouldn't work but might.`,
      ``,
      `=== SEED ===`,
      i.seed ?? "",
    ].join("\n"),
  },
];

export function listWorkflows() {
  return WORKFLOWS.map((w) => ({
    id: w.id,
    title: w.title,
    description: w.description,
    agent: w.agent,
    fields: w.fields,
    outputSchema: w.outputSchema,
  }));
}

export function getWorkflow(id: string): WorkflowDef | null {
  return WORKFLOWS.find((w) => w.id === id) ?? null;
}
