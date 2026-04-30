// Per-story chat. Streams via SSE. Auto-injects context server-side
// (style + bibles + RAG hits). Persists turns.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  chatStream,
  regenerateStream,
  type AgentName,
  type AgentSelection,
  type ChatMessage,
  type Story,
  type UsageResponse,
} from "../api.ts";
import { StoryConfig } from "./StoryConfig.tsx";
import { MarkdownView } from "./MarkdownView.tsx";
import { PinnedContext } from "./PinnedContext.tsx";
import { usePins, clearPins } from "../pins.ts";

type Props = {
  storyId: number | null;
};

type ContextUsage = {
  style: { base: string | null; genres: string[] } | null;
  bibles: string[];
  loreHits: { path: string; heading: string | null; score: number }[];
  historyTurns: number;
};

export function ChatPanel({ storyId }: Props) {
  const [story, setStory] = useState<Story | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [agent, setAgent] = useState<AgentSelection>("auto");
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [lastContext, setLastContext] = useState<ContextUsage | null>(null);
  const [routedAgent, setRoutedAgent] = useState<AgentName | null>(null);
  const [routeReason, setRouteReason] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<number | null>(null);
  const [regenStreamText, setRegenStreamText] = useState("");
  const { formatForPrompt } = usePins(storyId ?? 0);
  const turnStartRef = useRef<number>(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const refreshUsage = async (sid: number) => {
    try {
      const u = await api.usage(sid);
      setUsage(u);
    } catch {
      /* non-fatal */
    }
  };

  useEffect(() => {
    setMessages([]);
    setStreamText("");
    setStory(null);
    setLastContext(null);
    if (!storyId) return;
    api.storyGet(storyId).then(setStory).catch((e: Error) => setErr(e.message));
    api
      .storyMessages(storyId)
      .then((r) => setMessages(r.messages))
      .catch((e: Error) => setErr(e.message));
    refreshUsage(storyId);
  }, [storyId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamText]);

  const send = async () => {
    if (!storyId || !draft.trim() || busy) return;
    const pinPrefix = storyId ? formatForPrompt() : "";
    const text = pinPrefix ? `${pinPrefix}\n\n${draft.trim()}` : draft.trim();
    setBusy(true);
    setErr(null);
    setStreamText("");
    setLastContext(null);
    setRoutedAgent(null);
    setRouteReason(null);

    // Optimistically push user message
    const optimistic: ChatMessage = {
      id: -Date.now(),
      story_id: storyId,
      role: "user",
      agent: null,
      content: text,
      context_used: null,
      created_at: Date.now(),
    };
    setMessages((cur) => [...cur, optimistic]);
    setDraft("");
    turnStartRef.current = Date.now();

    try {
      let buffered = "";
      for await (const ev of chatStream(storyId, text, agent)) {
        if (ev.event === "context") {
          const data = ev.data as {
            usage: ContextUsage;
            agent: AgentName;
            routeReason: string;
          };
          setLastContext(data.usage);
          setRoutedAgent(data.agent);
          setRouteReason(data.routeReason);
        } else if (ev.event === "delta") {
          const data = ev.data as { text: string };
          buffered += data.text;
          setStreamText(buffered);
        } else if (ev.event === "done") {
          // Refetch to get the final assistant row
          const r = await api.storyMessages(storyId);
          setMessages(r.messages);
          setStreamText("");
          refreshUsage(storyId);
          if (storyId) clearPins(storyId);
        } else if (ev.event === "error") {
          const data = ev.data as { error: string };
          throw new Error(data.error);
        }
      }
    } catch (e) {
      setErr((e as Error).message || "chat failed");
      setStreamText("");
    } finally {
      setBusy(false);
    }
  };

  const handleRegenerate = useCallback(
    async (fromMessageId: number, ag: AgentSelection, editedContent?: string) => {
      if (!storyId || busy || regeneratingId !== null) return;
      setRegeneratingId(fromMessageId);
      setRegenStreamText("");
      setErr(null);
      turnStartRef.current = Date.now();
      try {
        let buf = "";
        for await (const ev of regenerateStream(storyId, {
          fromMessageId,
          agent: ag,
          editedContent,
        })) {
          if (ev.event === "delta") {
            const data = ev.data as { text: string };
            buf += data.text;
            setRegenStreamText(buf);
          } else if (ev.event === "done") {
            const r = await api.storyMessages(storyId);
            setMessages(r.messages);
            setRegenStreamText("");
            refreshUsage(storyId);
          } else if (ev.event === "error") {
            const data = ev.data as { error: string };
            throw new Error(data.error);
          }
        }
      } catch (e) {
        setErr((e as Error).message || "regenerate failed");
        setRegenStreamText("");
      } finally {
        setRegeneratingId(null);
      }
    },
    [storyId, busy, regeneratingId]
  );

  const clearChat = async () => {
    if (!storyId) return;
    if (!confirm("Clear chat history for this story?")) return;
    await api.storyClearMessages(storyId);
    setMessages([]);
    setStreamText("");
    setLastContext(null);
  };

  const placeholder = useMemo(() => {
    if (!storyId) return "Pick a story first.";
    if (busy) return "Streaming…";
    return "Message — Cmd/Ctrl+Enter to send";
  }, [storyId, busy]);

  if (!storyId) {
    return (
      <div className="max-w-3xl mx-auto card text-center text-muted py-12">
        Pick a story from the top bar to start chatting.
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto h-full grid grid-rows-[auto,1fr,auto] gap-3">
      {story && <StoryConfig story={story} onUpdated={setStory} />}

      <div ref={scrollRef} className="card overflow-auto space-y-4">
        {err && (
          <div className="bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200 text-sm p-3 rounded">{err}</div>
        )}
        {messages.length === 0 && !streamText && (
          <p className="text-muted text-sm">No messages yet — start the conversation.</p>
        )}
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            m={m}
            isRegenerating={regeneratingId === m.id}
            regenStreamText={regeneratingId === m.id ? regenStreamText : ""}
            isDisabled={busy || regeneratingId !== null}
            onRegenerate={handleRegenerate}
          />
        ))}
        {streamText && (
          <MessageBubble
            m={{
              id: -1,
              story_id: storyId,
              role: "assistant",
              agent: routedAgent ?? agent,
              content: streamText,
              context_used: null,
              created_at: Date.now(),
            }}
            streaming
          />
        )}
      </div>

      {usage && <UsageHud usage={usage} turnStartTs={turnStartRef.current} />}

      {lastContext && (
        <details className="card text-xs">
          <summary className="cursor-pointer text-tealBright">
            {routedAgent && (
              <>
                <span className="font-mono">{routedAgent}</span>
                {routeReason && <span className="text-muted"> · {routeReason}</span>}
                <span className="text-muted"> · </span>
              </>
            )}
            {lastContext.bibles.length} bible(s), {lastContext.loreHits.length} RAG hit(s),{" "}
            {lastContext.historyTurns} prior turn(s)
            {lastContext.style && (
              <>
                {" "}
                · style: {lastContext.style.base}
                {lastContext.style.genres.length > 0
                  ? ` + ${lastContext.style.genres.join(" + ")}`
                  : ""}
              </>
            )}
          </summary>
          <div className="mt-2 space-y-1 font-mono">
            {lastContext.bibles.map((b) => (
              <div key={b}>📖 {b}</div>
            ))}
            {lastContext.loreHits.map((h, i) => (
              <div key={i}>
                🔍 [{h.score.toFixed(3)}] {h.path}
                {h.heading ? ` :: ${h.heading}` : ""}
              </div>
            ))}
          </div>
        </details>
      )}

      <div className="card">
        {storyId && <PinnedContext storyId={storyId} />}
        <div className="flex items-center gap-2 mb-2">
          <select
            className="input"
            value={agent}
            onChange={(e) => setAgent(e.target.value as AgentSelection)}
          >
            <option value="auto">Auto-route (smart pick)</option>
            <option value="claude">Claude — drafting / voice</option>
            <option value="codex">Codex — structural / brainstorm</option>
            <option value="gemini">Gemini — long-context / continuity</option>
          </select>
          <button onClick={clearChat} className="btn btn-ghost text-xs ml-auto">
            Clear chat
          </button>
        </div>
        <textarea
          className="input w-full font-ui resize-none"
          rows={3}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          disabled={busy}
        />
        <div className="mt-2 flex">
          <button
            onClick={send}
            disabled={busy || !draft.trim()}
            className="btn btn-primary ml-auto"
          >
            {busy ? "Streaming…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function fmtCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.001) return "<$0.001";
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function UsageHud({
  usage,
  turnStartTs,
}: {
  usage: UsageResponse;
  turnStartTs: number;
}) {
  // "This turn" = events newer than the last user message timestamp.
  const turnEvents = usage.events.filter((e) => e.ts >= turnStartTs);
  const turn = turnEvents.reduce(
    (acc, e) => ({
      input: acc.input + e.inputTokens,
      output: acc.output + e.outputTokens,
      cost: acc.cost + e.costUsd,
    }),
    { input: 0, output: 0, cost: 0 }
  );

  const total = usage.summary;

  return (
    <div className="card text-xs flex flex-wrap items-center gap-x-4 gap-y-1 font-mono">
      {turnStartTs > 0 && turnEvents.length > 0 && (
        <span>
          <span className="text-muted">this turn:</span>{" "}
          <span className="text-tealBright">{fmtNum(turn.input)} in</span> ·{" "}
          <span className="text-tealBright">{fmtNum(turn.output)} out</span> ·{" "}
          ~{fmtCost(turn.cost)}
        </span>
      )}
      <span>
        <span className="text-muted">story total:</span>{" "}
        {fmtNum(total.tokens)} · ~{fmtCost(total.costUsd)}
      </span>
      {usage.totals.length > 0 && (
        <span className="text-muted">
          {usage.totals
            .map((r) => `${r.agent}:${fmtCost(r.costUsd)}`)
            .join(" · ")}
        </span>
      )}
    </div>
  );
}

type BubbleProps = {
  m: ChatMessage;
  streaming?: boolean;
  isRegenerating?: boolean;
  regenStreamText?: string;
  isDisabled?: boolean;
  onRegenerate?: (fromId: number, agent: AgentSelection, editedContent?: string) => void;
};

function MessageBubble({
  m,
  streaming,
  isRegenerating,
  regenStreamText,
  isDisabled,
  onRegenerate,
}: BubbleProps) {
  const mine = m.role === "user";
  const [hover, setHover] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(m.content);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (!editing) setEditDraft(m.content);
  }, [m.content, editing]);

  const display = isRegenerating && regenStreamText ? regenStreamText : m.content;
  const isStreaming = streaming || isRegenerating;
  const supportsActions = !!onRegenerate && m.id > 0; // skip optimistic ids

  const saveEdit = () => {
    if (!editDraft.trim() || !onRegenerate) return;
    setEditing(false);
    setPickerOpen(false);
    onRegenerate(m.id, "auto", editDraft.trim());
  };

  const pickRerun = (ag: AgentName) => {
    setPickerOpen(false);
    onRegenerate?.(m.id, ag);
  };

  return (
    <div
      className={`flex ${mine ? "justify-end" : "justify-start"}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setPickerOpen(false);
      }}
    >
      <div className="relative max-w-[85%]">
        {hover && supportsActions && !isStreaming && !isDisabled && !editing && (
          <div className={`absolute -top-7 ${mine ? "right-0" : "left-0"} flex gap-1 z-10`}>
            {mine ? (
              <button
                onClick={() => setEditing(true)}
                className="px-2 py-0.5 text-xs rounded bg-bg dark:bg-paper border border-muted/30 text-muted hover:text-tealBright hover:border-tealBright"
              >
                Edit
              </button>
            ) : (
              <div className="relative">
                <button
                  onClick={() => setPickerOpen((v) => !v)}
                  className="px-2 py-0.5 text-xs rounded bg-bg dark:bg-paper border border-muted/30 text-muted hover:text-tealBright hover:border-tealBright"
                >
                  Rerun…
                </button>
                {pickerOpen && (
                  <div className="absolute top-full mt-1 left-0 flex gap-1 bg-bg dark:bg-paper border border-muted/30 rounded p-1 shadow-lg z-20 whitespace-nowrap">
                    {(["claude", "codex", "gemini"] as AgentName[]).map((ag) => (
                      <button
                        key={ag}
                        onClick={() => pickRerun(ag)}
                        className="px-2 py-0.5 text-xs rounded hover:bg-teal/30 hover:text-paper capitalize"
                      >
                        {ag}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div
          className={`rounded-lg px-4 py-3 text-sm leading-relaxed ${
            mine
              ? "bg-teal/30 text-paper"
              : "bg-paper/40 border border-bg/10 dark:bg-bg/60 dark:border-muted/20"
          } ${isRegenerating ? "opacity-70" : ""}`}
        >
          <div className="text-xs text-muted mb-1">
            {mine ? "You" : (m.agent ?? "assistant")}
            {isStreaming && <span className="ml-2 text-tealBright">streaming…</span>}
          </div>
          {editing ? (
            <div className="space-y-2">
              <textarea
                className="input w-full font-ui resize-none text-sm"
                rows={4}
                value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
                autoFocus
              />
              <div className="flex gap-2 justify-end">
                <button onClick={() => setEditing(false)} className="btn btn-ghost text-xs">
                  Cancel
                </button>
                <button
                  onClick={saveEdit}
                  disabled={!editDraft.trim()}
                  className="btn btn-primary text-xs"
                >
                  Save & regenerate
                </button>
              </div>
            </div>
          ) : mine || isStreaming ? (
            <pre className="whitespace-pre-wrap font-ui">{display}</pre>
          ) : (
            <MarkdownView content={display} />
          )}
        </div>
      </div>
    </div>
  );
}
