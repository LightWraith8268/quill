// Per-story chat. Streams via SSE. Auto-injects context server-side
// (style + bibles + RAG hits). Persists turns.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  chatStream,
  type AgentName,
  type AgentSelection,
  type ChatMessage,
  type Story,
} from "../api.ts";
import { StoryConfig } from "./StoryConfig.tsx";

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
  const scrollRef = useRef<HTMLDivElement>(null);

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
  }, [storyId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamText]);

  const send = async () => {
    if (!storyId || !draft.trim() || busy) return;
    const text = draft.trim();
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
          <div className="bg-red-900/40 text-red-200 text-sm p-3 rounded">{err}</div>
        )}
        {messages.length === 0 && !streamText && (
          <p className="text-muted text-sm">No messages yet — start the conversation.</p>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} m={m} />
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

function MessageBubble({ m, streaming }: { m: ChatMessage; streaming?: boolean }) {
  const mine = m.role === "user";
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-4 py-3 text-sm leading-relaxed ${
          mine ? "bg-teal/30" : "bg-bg/60 border border-muted/20"
        }`}
      >
        <div className="text-xs text-muted mb-1">
          {mine ? "You" : (m.agent ?? "assistant")}
          {streaming && <span className="ml-2 text-tealBright">streaming…</span>}
        </div>
        <pre className="whitespace-pre-wrap font-ui">{m.content}</pre>
      </div>
    </div>
  );
}
