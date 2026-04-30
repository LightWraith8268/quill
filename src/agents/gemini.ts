// Gemini CLI wrapper. Uses `gemini -p - --output-format stream-json` for streaming.
// Emits assistant deltas as `{type:"message", role:"assistant", delta:true, content:"..."}`.

import { resolveBin } from "./resolve.ts";

export type GeminiOpts = {
  systemPrompt?: string;
  cwd?: string;
  signal?: AbortSignal;
  bin?: string;
  model?: string;
};

type GeminiEvent = {
  type?: string;
  role?: string;
  content?: string;
  delta?: boolean;
  status?: string;
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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const text = extractText(line);
      if (text) yield text;
    }
  }
  if (buf.trim()) {
    const text = extractText(buf.trim());
    if (text) yield text;
  }

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
