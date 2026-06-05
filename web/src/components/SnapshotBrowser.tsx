// Canon history: freeze the series' entity+fact state into named snapshots,
// then diff any two to see what canon was added, removed, or reweighted between
// them. Story-scoped (snapshots belong to the story's series).

import { useEffect, useState } from "react";
import { api, type FactDiff, type SnapshotMeta } from "../api.ts";

const DIFF_TONE: Record<FactDiff["type"], string> = {
  added: "text-tealBright",
  removed: "text-red-500",
  reweighted: "text-amber-500",
};
const DIFF_SIGN: Record<FactDiff["type"], string> = {
  added: "+",
  removed: "−",
  reweighted: "~",
};

const prettyWeight = (w?: string) => (w ? w.replace(/_/g, " ") : "");

export function SnapshotBrowser({ storyId }: { storyId: number }) {
  const [snapshots, setSnapshots] = useState<SnapshotMeta[] | null>(null);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [diffs, setDiffs] = useState<FactDiff[] | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    api
      .kbSnapshots(storyId)
      .then((r) => setSnapshots(r.snapshots))
      .catch((e: Error) => setErr(e.message));
  };

  useEffect(() => {
    setSnapshots(null);
    setSelected(new Set());
    setDiffs(null);
    setName("");
    setNote("");
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storyId]);

  const create = async () => {
    if (creating) return;
    setCreating(true);
    setErr(null);
    try {
      await api.kbSnapshotCreate(
        storyId,
        name.trim() || undefined,
        note.trim() || undefined
      );
      setName("");
      setNote("");
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const toggleSelect = (id: number) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else {
        if (next.size >= 2) {
          const first = next.values().next().value;
          if (first !== undefined) next.delete(first);
        }
        next.add(id);
      }
      return next;
    });
    setDiffs(null);
  };

  const runDiff = async () => {
    if (selected.size !== 2 || !snapshots) return;
    const picked = snapshots.filter((s) => selected.has(s.id));
    // Older as A, newer as B, so added/removed read forward in time.
    const [a, b] = [...picked].sort((x, y) => x.created_at - y.created_at);
    if (!a || !b) return;
    setDiffBusy(true);
    setErr(null);
    try {
      const r = await api.kbSnapshotDiff(storyId, a.id, b.id);
      setDiffs(r.diffs);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setDiffBusy(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="card space-y-2">
        <h3 className="font-display text-lg">Canon history</h3>
        <p className="text-xs text-muted">
          Freeze the current canon, then diff two snapshots to see what changed.
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            className="input flex-1 min-w-[8rem]"
            placeholder="Snapshot name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={creating}
          />
          <input
            className="input flex-1 min-w-[8rem]"
            placeholder="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={creating}
          />
          <button className="btn btn-primary" onClick={create} disabled={creating}>
            {creating ? "Saving…" : "Snapshot now"}
          </button>
        </div>
      </div>

      {err && (
        <div className="bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200 text-sm p-3 rounded">
          {err}
        </div>
      )}

      {snapshots && snapshots.length === 0 && (
        <p className="text-muted text-sm">
          No snapshots yet. Capture one above to start tracking canon over time.
        </p>
      )}

      {snapshots && snapshots.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted">
              {selected.size === 0
                ? "Tick two snapshots to diff them."
                : `${selected.size} selected`}
            </span>
            <button
              className="btn btn-ghost text-xs ml-auto"
              onClick={runDiff}
              disabled={selected.size !== 2 || diffBusy}
            >
              {diffBusy ? "Diffing…" : "Diff selected"}
            </button>
            {selected.size > 0 && (
              <button
                className="btn btn-ghost text-xs"
                onClick={() => {
                  setSelected(new Set());
                  setDiffs(null);
                }}
              >
                Clear
              </button>
            )}
          </div>
          <ul className="space-y-1">
            {snapshots.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-2 text-xs p-2 border border-muted/20 rounded"
              >
                <input
                  type="checkbox"
                  checked={selected.has(s.id)}
                  onChange={() => toggleSelect(s.id)}
                  aria-label={`Select snapshot ${s.name} for diff`}
                  className="cursor-pointer"
                />
                <span className="font-medium truncate">{s.name}</span>
                {s.note && (
                  <span className="italic text-muted truncate">"{s.note}"</span>
                )}
                <span className="ml-auto text-muted font-mono shrink-0">
                  {new Date(s.created_at).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {diffs && (
        <div className="card space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="font-display text-lg">Diff</h3>
            <span className="text-xs text-muted">
              {diffs.length === 0
                ? "identical canon"
                : `${diffs.length} change${diffs.length === 1 ? "" : "s"}`}
            </span>
            <button
              className="btn btn-ghost text-xs ml-auto"
              onClick={() => setDiffs(null)}
            >
              close
            </button>
          </div>
          <ul className="space-y-1">
            {diffs.map((d, i) => (
              <li key={i} className="text-xs flex gap-2">
                <span className={`font-mono ${DIFF_TONE[d.type]}`}>
                  {DIFF_SIGN[d.type]}
                </span>
                <div className="min-w-0">
                  <span className="text-tealBright">{d.entity}</span>{" "}
                  <span>{d.claim}</span>
                  <span className="text-muted">
                    {d.type === "reweighted"
                      ? ` — ${prettyWeight(d.from)} → ${prettyWeight(d.to)}`
                      : d.type === "added"
                        ? ` — added as ${prettyWeight(d.to)}`
                        : ` — was ${prettyWeight(d.from)}`}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
