import { useState } from "react";
import { api, type SearchHit, type SearchMode } from "../api.ts";

export function SearchPanel() {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("lore");
  const [topK, setTopK] = useState(8);
  const [useRerank, setUseRerank] = useState(true);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const run = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.search(query.trim(), mode, topK, 40, useRerank);
      setHits(res.hits);
      setExpanded(new Set());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: number) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <div className="card space-y-3">
        <textarea
          className="input w-full font-ui resize-none"
          rows={2}
          placeholder="Search the vault…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
          }}
        />
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="input"
            value={mode}
            onChange={(e) => setMode(e.target.value as SearchMode)}
          >
            <option value="lore">Lore</option>
            <option value="style">Style</option>
            <option value="uncensored">Uncensored</option>
            <option value="any">Any</option>
          </select>
          <label className="text-sm text-muted flex items-center gap-2">
            top
            <input
              type="number"
              className="input w-16"
              min={1}
              max={50}
              value={topK}
              onChange={(e) => setTopK(Number(e.target.value))}
            />
          </label>
          <label className="text-sm flex items-center gap-2">
            <input
              type="checkbox"
              checked={useRerank}
              onChange={(e) => setUseRerank(e.target.checked)}
            />
            Rerank
          </label>
          <button
            onClick={run}
            disabled={busy || !query.trim()}
            className="btn btn-primary ml-auto"
          >
            {busy ? "Searching…" : "Search"}
          </button>
        </div>
        <p className="text-xs text-muted">⌘/Ctrl + Enter to search.</p>
      </div>

      {err && (
        <div className="bg-red-900/40 text-red-200 text-sm p-3 rounded">{err}</div>
      )}

      <div className="space-y-2">
        {hits.map((h) => {
          const open = expanded.has(h.chunkId);
          const score = h.rerankScore ?? 1 - h.vectorDistance;
          const preview = open ? h.content : h.content.slice(0, 280);
          return (
            <div
              key={h.chunkId}
              className="card cursor-pointer hover:border-tealBright/40"
              onClick={() => toggle(h.chunkId)}
            >
              <div className="flex items-center gap-2 text-xs text-muted mb-2">
                <span className="text-tealBright font-mono">
                  {score.toFixed(3)}
                </span>
                <span className="font-mono truncate">{h.filePath}</span>
                <span>
                  L{h.startLine}–{h.endLine}
                </span>
                <span className="ml-auto px-1.5 py-0.5 border border-muted/30 rounded">
                  {h.tags}
                </span>
              </div>
              {h.headingPath && (
                <div className="text-sm text-tealBright mb-1">{h.headingPath}</div>
              )}
              <pre className="whitespace-pre-wrap font-ui text-sm leading-relaxed">
                {preview}
                {!open && h.content.length > 280 && "…"}
              </pre>
            </div>
          );
        })}
        {!busy && hits.length === 0 && query && (
          <div className="text-muted text-sm">No matches yet — run a search.</div>
        )}
      </div>
    </div>
  );
}
