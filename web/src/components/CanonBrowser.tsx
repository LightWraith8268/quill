// Canon browser: the native knowledge layer, surfaced. Two modes — Search
// (canon-aware retrieval: facts ranked by relevance then weight, plus scoped
// manuscript matches) and Entities (the entity graph: relationships, facts,
// per-fact history). Plus entity/fact counts and a re-extract action to
// (re)build the graph from the story's bibles + manuscript. Scoped to the
// active story's series.

import { useEffect, useState, type FormEvent } from "react";
import { api, type CanonItem, type CanonWeight } from "../api.ts";
import { EntityBrowser } from "./EntityBrowser.tsx";
import { CanonReview } from "./CanonReview.tsx";

type CanonMode = "search" | "entities" | "review";

const WEIGHT_ORDER: CanonWeight[] = [
  "hard_canon",
  "soft_canon",
  "outline_plan",
  "draft_text",
  "note",
  "rejected",
];
const WEIGHT_LABEL: Record<CanonWeight, string> = {
  hard_canon: "Hard canon",
  soft_canon: "Soft canon",
  outline_plan: "Outline / plan",
  draft_text: "Draft text",
  note: "Note",
  rejected: "Rejected",
};
const WEIGHT_TONE: Record<CanonWeight, string> = {
  hard_canon: "text-tealBright",
  soft_canon: "text-teal dark:text-tealBright/80",
  outline_plan: "text-bg dark:text-paper",
  draft_text: "text-amber-500",
  note: "text-muted",
  rejected: "text-red-500",
};

export function CanonBrowser({ storyId }: { storyId: number }) {
  const [stats, setStats] = useState<{ entities: number; facts: number; pending?: number } | null>(null);
  const [mode, setMode] = useState<CanonMode>("search");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<CanonItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadStats = () => {
    api
      .kbStats(storyId)
      .then(setStats)
      .catch((e: Error) => setErr(e.message));
  };

  useEffect(() => {
    setStats(null);
    setItems(null);
    setQ("");
    loadStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storyId]);

  const search = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!q.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.kbSearch(storyId, q.trim());
      setItems(r.items);
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const extract = async () => {
    if (extracting) return;
    setExtracting(true);
    setErr(null);
    try {
      await api.kbExtract(storyId);
      loadStats();
      if (mode === "search" && q.trim()) await search();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setExtracting(false);
    }
  };

  const facts = items?.filter((i) => i.kind !== "chunk") ?? [];
  const chunks = items?.filter((i) => i.kind === "chunk") ?? [];

  const tab = (id: CanonMode, label: string, badge?: number) => (
    <button
      onClick={() => setMode(id)}
      className={`px-2 py-1 ${
        mode === id
          ? "bg-teal text-paper"
          : "text-bg dark:text-paper hover:bg-bg/10 dark:hover:bg-muted/10"
      }`}
    >
      {label}
      {badge ? (
        <span className="ml-1 inline-flex items-center justify-center rounded-full bg-tealBright text-bg text-[10px] px-1.5 min-w-[1.1rem]">
          {badge}
        </span>
      ) : null}
    </button>
  );

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="card flex flex-wrap items-center gap-3 text-sm">
        <span className="font-display text-lg">Canon</span>
        <span className="text-muted">
          {stats
            ? `${stats.entities} entit${stats.entities === 1 ? "y" : "ies"} · ${stats.facts} fact${stats.facts === 1 ? "" : "s"}`
            : "loading…"}
        </span>
        <div className="inline-flex rounded border border-muted/30 overflow-hidden text-xs">
          {tab("search", "Search")}
          {tab("entities", "Entities")}
          {tab("review", "Review", stats?.pending)}
        </div>
        <button
          className="btn btn-ghost text-xs ml-auto"
          onClick={extract}
          disabled={extracting}
          title="Re-read this story's bibles + manuscript and rebuild the canon graph (uses the LLM)"
        >
          {extracting ? "Extracting…" : "Re-extract canon"}
        </button>
      </div>

      {err && (
        <div className="bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200 text-sm p-3 rounded">
          {err}
        </div>
      )}

      {stats && stats.facts === 0 && mode !== "review" && (
        <div className="card text-center text-muted py-8 text-sm">
          No canon extracted yet for this story. Hit{" "}
          <span className="text-tealBright">Re-extract canon</span> to build it
          from the bibles + manuscript, or use{" "}
          <span className="text-tealBright">Review</span> to let canon build
          itself as you write.
        </div>
      )}

      {mode === "review" && (
        <CanonReview storyId={storyId} onChanged={loadStats} />
      )}

      {mode === "entities" && stats && stats.facts > 0 && (
        <EntityBrowser storyId={storyId} />
      )}

      {mode === "search" && stats && stats.facts > 0 && (
        <>
          <form onSubmit={search} className="flex gap-2">
            <input
              className="input flex-1"
              placeholder="Search canon — a character, place, decision, timeline…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || !q.trim()}
            >
              {busy ? "…" : "Search"}
            </button>
          </form>

          {items && items.length === 0 && (
            <p className="text-muted text-sm">No canon matches for “{q}”.</p>
          )}

          {WEIGHT_ORDER.map((w) => {
            const group = facts.filter((fact) => fact.canonWeight === w);
            if (group.length === 0) return null;
            return (
              <div key={w} className="space-y-1">
                <h3 className={`text-xs uppercase tracking-wide ${WEIGHT_TONE[w]}`}>
                  {WEIGHT_LABEL[w]} · {group.length}
                </h3>
                <ul className="space-y-1">
                  {group.map((fact, i) => (
                    <li key={i} className="card text-sm py-2">
                      <div className="flex items-center gap-2">
                        {fact.entity && (
                          <span className="text-tealBright font-medium">
                            {fact.entity}
                          </span>
                        )}
                        <span className="text-[10px] uppercase text-muted">
                          {fact.kind}
                        </span>
                        {fact.sourcePath && (
                          <span className="ml-auto text-[11px] text-muted font-mono truncate max-w-[45%]">
                            {fact.sourcePath}
                            {fact.sourceRef ? ` :: ${fact.sourceRef}` : ""}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5">{fact.text}</div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}

          {chunks.length > 0 && (
            <div className="space-y-1">
              <h3 className="text-xs uppercase tracking-wide text-muted">
                Manuscript matches · {chunks.length}
              </h3>
              {chunks.map((ch, i) => (
                <div key={i} className="card text-sm">
                  <div className="text-[11px] text-muted font-mono truncate">
                    {ch.sourcePath}
                    {ch.sourceRef ? ` :: ${ch.sourceRef}` : ""}
                  </div>
                  <div className="mt-1 line-clamp-4 whitespace-pre-wrap">{ch.text}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
