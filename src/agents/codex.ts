// Codex CLI wrapper. Uses `codex exec --json` for streaming JSON events.
// Stdin-fed prompt to avoid arg-length issues.
//
// Codex emits coarse-grained events: thread.started, turn.started, item.completed
// (with item.text), turn.completed. Codex doesn't stream token-level deltas — it
// emits each completed agent message in one shot.

import { resolveBin } from "./resolve.ts";
import type { AgentUsage } from "./claude.ts";

export type CodexOpts = {
  systemPrompt?: string;
  cwd?: string;
  signal?: AbortSignal;
  bin?: string;
  model?: string;
  onUsage?: (u: AgentUsage) => void;
};

type CodexEvent = {
  type?: string;
  item?: { id?: string; type?: string; text?: string };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
  model?: string;
};

export async function* codexStream(
  prompt: string,
  opts: CodexOpts = {}
): AsyncGenerator<string, void, void> {
  const args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only"];
  if (opts.model) args.push("-m", opts.model);

  const composed = opts.systemPrompt
    ? `${opts.systemPrompt}\n\n=== USER MESSAGE ===\n${prompt}`
    : prompt;

  const child = Bun.spawn([resolveBin(opts.bin ?? "codex"), ...args], {
    cwd: opts.cwd,
    stdin: new TextEncoder().encode(composed),
    stdout: "pipe",
    stderr: "pipe",
  });

  if (opts.signal) {
    if (opts.signal.aborted) {
      child.kill();
      return;
    }
    opts.signal.addEventListener("abort", () => child.kill(), { once: true });
  }

  let buf = "";
  const reader = child.stdout.getReader();
  const dec = new TextDecoder();
  let finalUsage: AgentUsage | null = null;

  const handleLine = (line: string): string | null => {
    const u = extractUsage(line);
    if (u) finalUsage = u;
    return extractText(line);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const text = handleLine(line);
      if (text) yield text;
    }
  }
  if (buf.trim()) {
    const text = handleLine(buf.trim());
    if (text) yield text;
  }

  if (finalUsage && opts.onUsage) opts.onUsage(finalUsage);

  const code = await child.exited;
  if (code !== 0) {
    const errBuf = await new Response(child.stderr).text();
    throw new Error(`codex exited ${code}${errBuf ? `: ${errBuf.slice(0, 500)}` : ""}`);
  }
}

function extractText(line: string): string | null {
  let json: CodexEvent;
  try {
    json = JSON.parse(line) as CodexEvent;
  } catch {
    return null;
  }
  if (json.type === "item.completed" && json.item?.type === "agent_message") {
    return json.item.text ?? null;
  }
  return null;
}

function extractUsage(line: string): AgentUsage | null {
  let json: CodexEvent;
  try {
    json = JSON.parse(line) as CodexEvent;
  } catch {
    return null;
  }
  // Codex emits `turn.completed` with cumulative usage.
  if (json.type === "turn.completed" && json.usage) {
    return {
      inputTokens: json.usage.input_tokens ?? 0,
      outputTokens: json.usage.output_tokens ?? 0,
      cachedInputTokens: json.usage.cached_input_tokens ?? 0,
      model: json.model ?? null,
    };
  }
  return null;
}
