// Self-building canon review queue. Candidate facts extracted from prose (on
// save, or via "Scan for new canon") land here classified new vs contradicts.
// Accept → promoted into the canon graph; Reject → discarded. Contradictions
// surface first, with the conflicting on-file claim shown inline.

import { useCallback, useEffect, useState } from "react";
import { api, type PendingFact } from "../api.ts";

export function CanonReview({
  storyId,
  onChanged,
}: {
  storyId: number;
  onChanged?: () => void;
}) {
  const [pending, setPending] = useState<PendingFact[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .kbPending(storyId)
      .then((r) => setPending(r.pending))
      .catch((e: Error) => setErr(e.message));
  }, [storyId]);

  useEffect(() => {
    setPending(null);
    setNote(null);
    load();
  }, [load]);

  const scan = async () => {
    if (scanning) return;
    setScanning(true);
    setErr(null);
    setNote(null);
    try {
      const r = await api.kbPropose(storyId);
      setNote(
        r.proposed > 0
          ? `Found ${r.proposed} candidate fact${r.proposed === 1 ? "" : "s"}` +
              (r.contradictions ? ` · ${r.contradictions} contradiction(s)` : "")
          : "No new canon found in the manuscript."
      );
      load();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setScanning(false);
    }
  };

  const decide = async (pid: number, accept: boolean) => {
    setBusyId(pid);
    setErr(null);
    try {
      if (accept) await api.kbPendingAccept(storyId, pid);
      else await api.kbPendingReject(storyId, pid);
      setPending((cur) => (cur ? cur.filter((p) => p.id !== pid) : cur));
      onChanged?.();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const clearAll = async () => {
    if (!confirm("Reject all pending candidates?")) return;
    try {
      await api.kbPendingClear(storyId);
      setPending([]);
    } catch (ex) {
      setErr((ex as Error).message);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">
          {pending == null
            ? "loading…"
            : `${pending.length} candidate${pending.length === 1 ? "" : "s"} awaiting review`}
        </span>
        <button
          className="btn btn-primary text-xs ml-auto"
          onClick={scan}
          disabled={scanning}
          title="Read this story's manuscript and propose new/contradicting canon facts (uses the LLM)"
        >
          {scanning ? "Scanning…" : "Scan for new canon"}
        </button>
        {pending && pending.length > 0 && (
          <button className="btn btn-ghost text-xs" onClick={clearAll}>
            Reject all
          </button>
        )}
      </div>

      {note && <div className="text-xs text-tealBright">{note}</div>}
      {err && (
        <div className="bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200 text-sm p-3 rounded">
          {err}
        </div>
      )}

      {pending && pending.length === 0 && (
        <div className="card text-center text-muted py-8 text-sm">
          Nothing to review. As you write (or hit{" "}
          <span className="text-tealBright">Scan for new canon</span>), new facts
          appear here to accept into canon.
        </div>
      )}

      <ul className="space-y-2">
        {pending?.map((p) => {
          const isConflict = p.classification === "contradicts";
          return (
            <li
              key={p.id}
              className={`card text-sm py-2 border-l-2 ${
                isConflict ? "border-l-red-500" : "border-l-tealBright"
              }`}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-tealBright font-medium">{p.entity_name}</span>
                <span className="text-[10px] uppercase text-muted">{p.entity_kind}</span>
                <span
                  className={`text-[10px] uppercase font-medium ${
                    isConflict ? "text-red-500" : "text-teal dark:text-tealBright/80"
                  }`}
                >
                  {isConflict ? "⚠ contradicts canon" : "new"}
                </span>
                {p.source_path && (
                  <span className="ml-auto text-[11px] text-muted font-mono truncate max-w-[40%]">
                    {p.source_path}
                  </span>
                )}
              </div>
              <div className="mt-1">{p.claim}</div>
              {isConflict && p.conflict_claim && (
                <div className="mt-1 text-xs text-red-500/90 border-l-2 border-red-500/40 pl-2">
                  on file: {p.conflict_claim}
                </div>
              )}
              <div className="mt-2 flex gap-2 justify-end">
                <button
                  className="btn btn-ghost text-xs"
                  onClick={() => decide(p.id, false)}
                  disabled={busyId === p.id}
                >
                  Reject
                </button>
                <button
                  className="btn btn-primary text-xs"
                  onClick={() => decide(p.id, true)}
                  disabled={busyId === p.id}
                  title={isConflict ? "Accept the new claim into canon anyway" : "Accept into canon"}
                >
                  {busyId === p.id ? "…" : "Accept"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
