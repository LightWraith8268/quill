// "Ask your story": ask a natural-language question about the whole manuscript.
// Streams a cited answer grounded in retrieved canon + passages, and lists the
// sources it drew on. Read-only — this is Q&A, not editing.

import { useRef, useState, type FormEvent } from "react";
import { askStoryStream, type AskSource } from "../api.ts";
import { MarkdownView } from "./MarkdownView.tsx";

const EXAMPLES = [
  "Where did I foreshadow the betrayal?",
  "Every scene with the captain and the artifact",
  "Are there contradictions about the ship's age?",
  "What's left unresolved about the protagonist's family?",
];

export function AskPanel({ storyId }: { storyId: number }) {
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<AskSource[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const busyRef = useRef(false);

  const ask = async (question: string) => {
    if (!question.trim() || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setErr(null);
    setAnswer("");
    setSources([]);
    try {
      let buf = "";
      for await (const ev of askStoryStream(storyId, question.trim())) {
        if (ev.event === "sources") {
          setSources((ev.data as { sources: AskSource[] }).sources);
        } else if (ev.event === "delta") {
          buf += (ev.data as { text: string }).text;
          setAnswer(buf);
        } else if (ev.event === "error") {
          throw new Error((ev.data as { error: string }).error);
        }
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    ask(q);
  };

  return (
    <div className="space-y-3">
      <form onSubmit={submit} className="flex gap-2">
        <input
          className="input flex-1"
          placeholder="Ask anything about your story…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={busy || !q.trim()}>
          {busy ? "Thinking…" : "Ask"}
        </button>
      </form>

      {!answer && !busy && (
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              onClick={() => {
                setQ(ex);
                ask(ex);
              }}
              className="text-xs px-2 py-1 rounded border border-muted/30 text-muted hover:border-tealBright hover:text-tealBright"
            >
              {ex}
            </button>
          ))}
        </div>
      )}

      {err && (
        <div className="bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200 text-sm p-3 rounded">
          {err}
        </div>
      )}

      {(answer || busy) && (
        <div className="card">
          {answer ? (
            <MarkdownView content={answer} />
          ) : (
            <p className="text-muted text-sm animate-pulse">Searching the manuscript…</p>
          )}
        </div>
      )}

      {sources.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-xs uppercase tracking-wide text-muted">
            Sources · {sources.length}
          </h3>
          <ul className="space-y-1">
            {sources.map((s, i) => (
              <li key={i} className="card text-xs py-1.5 flex items-center gap-2 font-mono">
                <span className="text-[10px] uppercase text-muted w-12 shrink-0">{s.kind}</span>
                <span className="truncate">
                  {s.path}
                  {s.ref ? ` :: ${s.ref}` : ""}
                </span>
                <span className="text-muted ml-auto shrink-0">{s.score.toFixed(3)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
