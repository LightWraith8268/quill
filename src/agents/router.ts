// Agent router. Maps "claude" | "codex" | "gemini" | "auto" to the right wrapper.
// Auto mode picks an agent from heuristic intent classification of the user message.

import { claudeStream, type ClaudeOpts } from "./claude.ts";
import { codexStream, type CodexOpts } from "./codex.ts";
import { geminiStream, type GeminiOpts } from "./gemini.ts";

export type AgentName = "claude" | "codex" | "gemini";
export type AgentSelection = AgentName | "auto";

export type AgentOpts = ClaudeOpts & CodexOpts & GeminiOpts;

export type RouteResult = {
  agent: AgentName;
  reason: string;
  stream: AsyncGenerator<string, void, void>;
};

/**
 * Heuristic auto-route. Cheap keyword classifier — good enough first pass.
 * - Gemini = bulk reading / continuity sweeps / cross-book lore (massive context)
 * - Codex = structural critique / brainstorming alternatives / plot mechanics
 * - Claude = drafting / revision / voice / line-edit / character work (default)
 */
export function autoRoute(message: string): { agent: AgentName; reason: string } {
  const m = message.toLowerCase();

  // Gemini: bulk / continuity / cross-book signals
  const geminiHints = [
    "continuity",
    "across books",
    "across all",
    "whole manuscript",
    "all chapters",
    "full book",
    "scan the",
    "every chapter",
    "summarize the entire",
    "cross-reference",
    "sweep",
  ];
  for (const h of geminiHints) {
    if (m.includes(h)) return { agent: "gemini", reason: `auto: matched "${h}" → bulk/continuity` };
  }

  // Codex: structural / brainstorm / critique
  const codexHints = [
    "brainstorm",
    "alternatives",
    "alternative scene",
    "alt take",
    "structural",
    "structure critique",
    "plot hole",
    "what's broken",
    "devil's advocate",
    "challenge this",
    "critique",
    "alternate version",
    "outline",
    "act structure",
  ];
  for (const h of codexHints) {
    if (m.includes(h)) return { agent: "codex", reason: `auto: matched "${h}" → structural/brainstorm` };
  }

  return { agent: "claude", reason: "auto: default → drafting/voice" };
}

export function pickAgent(
  selection: AgentSelection,
  message: string
): { agent: AgentName; reason: string } {
  if (selection !== "auto") {
    return { agent: selection, reason: "user-selected" };
  }
  return autoRoute(message);
}

export function streamFor(
  agent: AgentName,
  prompt: string,
  opts: AgentOpts
): AsyncGenerator<string, void, void> {
  switch (agent) {
    case "claude":
      return claudeStream(prompt, opts);
    case "codex":
      return codexStream(prompt, opts);
    case "gemini":
      return geminiStream(prompt, opts);
  }
}
