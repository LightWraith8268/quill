// Claude Code CLI wrapper. Uses Bun.spawn + stream-json mode.
// Prompt + system prompt are piped via stdin to avoid Windows arg-length limits.

export type AgentUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  model?: string | null;
};

// Surfaced to the UI so a chat turn can show what the agent did to the vault.
export type AgentToolEvent =
  | { phase: "start"; id: string; name: string; input: unknown }
  | { phase: "end"; id: string; ok: boolean };

export type ClaudeOpts = {
  systemPrompt?: string;
  cwd?: string;
  signal?: AbortSignal;
  bin?: string;
  // Per-call model override. Utility (non-prose) paths pass cfg.CLAUDE_FAST_MODEL
  // here to run on a faster model; prose paths pass nothing so they keep the
  // prose model (CLAUDE_MODEL env, default "" = the CLI default, e.g. Opus 4.8).
  model?: string;
  // Skip loading MCP servers (--strict-mcp-config with no --mcp-config = none).
  // Cuts spawn latency for chat. Defaults from CLAUDE_SKIP_MCP env (default on).
  skipMcp?: boolean;
  // Agentic mode: bypass permissions so the spawned CLI can Read/Write/Edit/
  // Grep/Glob/Bash inside cwd headlessly (the story folder sandboxes it). When
  // false (default), no permission flag is passed — chat stays fast + advisory.
  agentic?: boolean;
  onToolCall?: (e: AgentToolEvent) => void;
  onUsage?: (u: AgentUsage) => void;
};

// What claudeStream yields. Prose text is a plain string; extended-thinking is
// wrapped so consumers can show "the model is working" live (and never splice
// thinking into the prose). Consumers that only want prose: `typeof c === "string"`.
export type StreamChunk = string | { thinking: string };

// Perf knobs read from env so every caller (router → chat/inline) gets them
// without threading config through. opts.* still overrides per-call.
const ENV_MODEL = process.env.CLAUDE_MODEL?.trim() || "";
const ENV_SKIP_MCP =
  (process.env.CLAUDE_SKIP_MCP ?? "true").trim().toLowerCase() !== "false";

type StreamEvent = {
  type?: string;
  subtype?: string;
  message?: {
    content?: {
      type: string;
      text?: string;
      thinking?: string; // thinking block (full message)
      id?: string; // tool_use
      name?: string; // tool_use
      input?: unknown; // tool_use
      tool_use_id?: string; // tool_result
      is_error?: boolean; // tool_result
    }[];
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
  event?: {
    type?: string;
    delta?: { type?: string; text?: string; thinking?: string };
  };
};

import { resolveBin as resolvePathBin } from "./resolve.ts";

function resolveBin(bin: string | undefined): string {
  return resolvePathBin(bin ?? "claude");
}

export async function* claudeStream(
  prompt: string,
  opts: ClaudeOpts = {}
): AsyncGenerator<StreamChunk, void, void> {
  const args = ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose"];
  const model = opts.model ?? ENV_MODEL;
  const skipMcp = opts.skipMcp ?? ENV_SKIP_MCP;
  if (model) args.push("--model", model);
  if (skipMcp) args.push("--strict-mcp-config");
  // Agent mode: let tools run without prompts (cwd is the sandbox). Without
  // this, headless tool calls would be denied and writing wouldn't happen.
  if (opts.agentic) args.push("--permission-mode", "bypassPermissions");
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
  let streamed = false;

  const handleLine = (line: string): StreamChunk | null => {
    let json: StreamEvent;
    try {
      json = JSON.parse(line) as StreamEvent;
    } catch {
      return null;
    }

    const u = usageFrom(json);
    if (u) finalUsage = u;

    // Tool activity comes on full (non-partial) assistant/user message lines:
    // assistant → tool_use blocks (start), user → tool_result blocks (end).
    if (opts.onToolCall && Array.isArray(json.message?.content)) {
      for (const b of json.message.content) {
        if (b.type === "tool_use" && b.id && b.name) {
          opts.onToolCall({ phase: "start", id: b.id, name: b.name, input: b.input });
        } else if (b.type === "tool_result" && b.tool_use_id) {
          opts.onToolCall({ phase: "end", id: b.tool_use_id, ok: b.is_error !== true });
        }
      }
    }

    // Extended-thinking deltas — yielded live (wrapped) so the UI can show the
    // model working during the silent pre-prose phase. Never spliced into prose.
    if (
      json.type === "stream_event" &&
      json.event?.type === "content_block_delta" &&
      json.event.delta?.type === "thinking_delta" &&
      json.event.delta.thinking
    ) {
      return { thinking: json.event.delta.thinking };
    }

    // Token-by-token partial delta (needs --include-partial-messages).
    if (
      json.type === "stream_event" &&
      json.event?.type === "content_block_delta" &&
      json.event.delta?.type === "text_delta" &&
      json.event.delta.text
    ) {
      streamed = true;
      return json.event.delta.text;
    }

    // Completed assistant block — only emit if no deltas streamed, so a CLI
    // build without partial-message support still works (de-dupe otherwise).
    if (!streamed) return textFrom(json);
    return null;
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
      const out = handleLine(line);
      if (out) yield out;
    }
  }
  if (buf.trim()) {
    const out = handleLine(buf.trim());
    if (out) yield out;
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

function textFrom(json: StreamEvent): string | null {
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

function usageFrom(json: StreamEvent): AgentUsage | null {
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
  for await (const chunk of claudeStream(prompt, opts)) {
    if (typeof chunk === "string") parts.push(chunk);
  }
  return parts.join("");
}
