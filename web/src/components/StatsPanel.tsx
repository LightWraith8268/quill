import { useEffect, useState } from "react";
import { api, type ReindexResult, type Stats } from "../api.ts";

export function StatsPanel() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [last, setLast] = useState<ReindexResult | null>(null);

  const refresh = () => {
    api.stats().then(setStats).catch((e: Error) => setErr(e.message));
  };

  useEffect(refresh, []);

  const reindex = async (full: boolean) => {
    if (
      full &&
      !confirm("Full reindex re-embeds every chunk. May take a while + use tokens. Continue?")
    )
      return;
    setReindexing(true);
    setErr(null);
    try {
      const r = await api.reindex(full);
      setLast(r);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setReindexing(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="card">
        <h2 className="font-display text-2xl mb-4">Vault Stats</h2>
        {stats ? (
          <div className="grid grid-cols-3 gap-4 text-center">
            <Stat label="Files" value={stats.files} />
            <Stat label="Chunks" value={stats.chunks} />
            <Stat label="Vectors" value={stats.vec_rows} />
          </div>
        ) : (
          <p className="text-muted text-sm">Loading…</p>
        )}
      </div>

      <div className="card space-y-3">
        <h3 className="font-display text-lg">Reindex</h3>
        <p className="text-sm text-muted">
          Incremental reindex walks the vault and only re-embeds changed files
          (mtime + hash diff). Full reindex rebuilds everything.
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => reindex(false)}
            disabled={reindexing}
            className="btn btn-primary"
          >
            {reindexing ? "Working…" : "Reindex (incremental)"}
          </button>
          <button
            onClick={() => reindex(true)}
            disabled={reindexing}
            className="btn btn-ghost"
          >
            Full rebuild
          </button>
        </div>
        {last && (
          <div className="text-sm font-mono bg-paper/40 border border-bg/10 dark:bg-bg/60 dark:border-muted/20 rounded p-3">
            <div>files scanned: {last.filesScanned}</div>
            <div>changed: {last.filesChanged}</div>
            <div>deleted: {last.filesDeleted}</div>
            <div>chunks written: {last.chunksWritten}</div>
            <div>tokens embedded: {last.tokensEmbedded.toLocaleString()}</div>
          </div>
        )}
      </div>

      {err && <div className="bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200 text-sm p-3 rounded">{err}</div>}
    </div>
  );
}

function Stat(props: { label: string; value: number }) {
  return (
    <div>
      <div className="font-display text-3xl text-tealBright">
        {props.value.toLocaleString()}
      </div>
      <div className="text-xs text-muted uppercase tracking-wide">{props.label}</div>
    </div>
  );
}
