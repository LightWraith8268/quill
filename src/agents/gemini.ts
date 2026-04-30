// Gemini CLI wrapper. Uses `gemini -p - --output-format stream-json` for streaming.
// Emits assistant deltas as `{type:"message", role:"assistant", delta:true, content:"..."}`.

import { resolveBin } from "./resolve.ts";
import type { AgentUsage } from "./claude.ts";

export type GeminiOpts = {
  systemPrompt?: string;
  cwd?: string;
  signal?: AbortSignal;
  bin?: string;
  model?: string;
  onUsage?: (u: AgentUsage) => void;
};

type GeminiEvent = {
  type?: string;
  role?: string;
  content?: string;
  delta?: boolean;
  status?: string;
  stats?: {
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    cached?: number;
    cached_tokens?: number;
  };
  model?: string;
};

export async function* geminiStream(
  prompt: string,
  opts: GeminiOpts = {}
): AsyncGenerator<string, void, void> {
  const args = ["-p", "-", "--output-format", "stream-json"];
  if (opts.model) args.push("-m", opts.model);

  const composed = opts.systemPrompt
    ? `${opts.systemPrompt}\n\n=== USER MESSAGE ===\n${prompt}`
    : prompt;

  const child = Bun.spawn([resolveBin(opts.bin ?? "gemini"), ...args], {
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
    throw new Error(`gemini exited ${code}${errBuf ? `: ${errBuf.slice(0, 500)}` : ""}`);
  }
}

function extractText(line: string): string | null {
  let json: GeminiEvent;
  try {
    json = JSON.parse(line) as GeminiEvent;
  } catch {
    return null;
  }
  if (
    json.type === "message" &&
    json.role === "assistant" &&
    typeof json.content === "string"
  ) {
    return json.content;
  }
  return null;
}

function extractUsage(line: string): AgentUsage | null {
  let json: GeminiEvent;
  try {
    json = JSON.parse(line) as GeminiEvent;
  } catch {
    return null;
  }
  if ((json.type === "result" || json.type === "stats") && json.stats) {
    const s = json.stats;
    const inTok = s.input_tokens ?? 0;
    const outTok = s.output_tokens ?? 0;
    const cached = s.cached_tokens ?? s.cached ?? 0;
    // Fallback: if only total reported, treat as input.
    const total = s.total_tokens ?? 0;
    return {
      inputTokens: inTok || (total && !outTok ? total : 0),
      outputTokens: outTok,
      cachedInputTokens: cached,
      model: json.model ?? null,
    };
  }
  return null;
}
