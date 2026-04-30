// Claude Code CLI wrapper. Uses Bun.spawn + stream-json mode.
// Prompt + system prompt are piped via stdin to avoid Windows arg-length limits.

export type AgentUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  model?: string | null;
};

export type ClaudeOpts = {
  systemPrompt?: string;
  cwd?: string;
  signal?: AbortSignal;
  bin?: string;
  onUsage?: (u: AgentUsage) => void;
};

type StreamEvent = {
  type?: string;
  subtype?: string;
  message?: {
    content?: { type: string; text?: string }[];
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  model?: string;
  delta?: { text?: string; type?: string };
  content_block?: { type: string; text?: string };
};

import { resolveBin as resolvePathBin } from "./resolve.ts";

function resolveBin(bin: string | undefined): string {
  return resolvePathBin(bin ?? "claude");
}

export async function* claudeStream(
  prompt: string,
  opts: ClaudeOpts = {}
): AsyncGenerator<string, void, void> {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  const composed = opts.systemPrompt
    ? `${opts.systemPrompt}\n\n=== USER MESSAGE ===\n${prompt}`
    : prompt;

  const child = Bun.spawn([resolveBin(opts.bin), ...args], {
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

  const exitCode = await child.exited;
  if (exitCode !== 0) {
    const errBuf = await new Response(child.stderr).text();
    throw new Error(
      `claude exited ${exitCode}${errBuf ? `: ${errBuf.slice(0, 500)}` : ""}`
    );
  }
}

function extractText(line: string): string | null {
  let json: StreamEvent;
  try {
    json = JSON.parse(line) as StreamEvent;
  } catch {
    return null;
  }
  if (json.message?.content && Array.isArray(json.message.content)) {
    const parts = json.message.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string);
    if (parts.length > 0) return parts.join("");
  }
  if (json.delta?.text) return json.delta.text;
  if (json.content_block?.type === "text" && json.content_block.text) {
    return json.content_block.text;
  }
  return null;
}

function extractUsage(line: string): AgentUsage | null {
  let json: StreamEvent;
  try {
    json = JSON.parse(line) as StreamEvent;
  } catch {
    return null;
  }
  // Claude Code emits a final `result` event with totals, plus per-message
  // events with cumulative usage. Prefer whichever we last see.
  const u = json.usage ?? json.message?.usage;
  if (!u) return null;
  const cached =
    (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cachedInputTokens: cached,
    model: json.message?.model ?? json.model ?? null,
  };
}

export async function claudeOnce(
  prompt: string,
  opts: ClaudeOpts = {}
): Promise<string> {
  const parts: string[] = [];
  for await (const chunk of claudeStream(prompt, opts)) parts.push(chunk);
  return parts.join("");
}
