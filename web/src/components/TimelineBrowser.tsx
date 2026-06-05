// Timeline + knowledge-state view. A chapter slider scrubs the story's canon:
// at chapter N you see what's already established (usable) vs. what's still a
// future reveal (off-limits for the writing agent). Each bounded fact shows its
// chapter range; any fact can be given a "known from chapter" so the timeline
// fills in as the story is plotted. The continuity safeguard, made visible.

import { useCallback, useEffect, useState } from "react";
import { api, type KnowledgeState, type TimelineFact } from "../api.ts";

export function TimelineBrowser({ storyId }: { storyId: number }) {
  const [events, setEvents] = useState<TimelineFact[] | null>(null);
  const [max, setMax] = useState(1);
  const [chapter, setChapter] = useState(1);
  const [state, setState] = useState<KnowledgeState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editId, setEditId] = useState<number | null>(null);

  const loadState = useCallback(
    (ch: number) => {
      api
        .kbTimeline(storyId, ch)
        .then((r) => {
          setEvents(r.events);
          setMax(Math.max(r.maxChapter, ch));
          setState(r.state);
        })
        .catch((e: Error) => setErr(e.message));
    },
    [storyId]
  );

  useEffect(() => {
    setEvents(null);
    setState(null);
    setChapter(1);
    loadState(1);
  }, [loadState]);

  const onScrub = (ch: number) => {
    setChapter(ch);
    loadState(ch);
  };

  const setBounds = async (factId: number, from: number | null) => {
    setEditId(null);
    try {
      await api.kbSetBounds(storyId, factId, { fromChapter: from });
      loadState(chapter);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (err) {
    return (
      <div className="bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200 text-sm p-3 rounded">
        {err}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="card space-y-2">
        <div className="flex items-center gap-3 text-sm">
          <span className="font-medium">As of chapter</span>
          <span className="text-tealBright font-mono text-lg w-8 text-center">{chapter}</span>
          <input
            type="range"
            min={1}
            max={Math.max(max, 1)}
            value={chapter}
            onChange={(e) => onScrub(Number(e.target.value))}
            className="flex-1 accent-teal"
          />
          <span className="text-muted text-xs">of {max}</span>
        </div>
        <p className="text-xs text-muted">
          Drag to scrub the timeline. Facts established at or before this chapter are{" "}
          <span className="text-tealBright">known</span>; later reveals are{" "}
          <span className="text-amber-500">not yet known</span>.
        </p>
      </div>

      {state && (
        <div className="grid sm:grid-cols-2 gap-3">
          <FactColumn
            title={`Known by ch ${chapter}`}
            tone="text-tealBright"
            facts={state.active}
            chapter={chapter}
            editId={editId}
            onEdit={setEditId}
            onSetBounds={setBounds}
          />
          <FactColumn
            title="Not yet revealed"
            tone="text-amber-500"
            facts={state.future}
            chapter={chapter}
            editId={editId}
            onEdit={setEditId}
            onSetBounds={setBounds}
          />
        </div>
      )}

      <div className="space-y-1">
        <h3 className="text-xs uppercase tracking-wide text-muted">
          Reveal timeline · {events?.length ?? 0} bounded fact(s)
        </h3>
        {events && events.length === 0 && (
          <p className="text-muted text-xs">
            No facts have chapter bounds yet. Give a fact a “known from chapter” (✎ on
            any card) and it joins the timeline.
          </p>
        )}
        <ul className="space-y-1">
          {events?.map((f) => (
            <li key={f.id} className="card text-sm py-2 flex items-center gap-2">
              <span className="font-mono text-xs text-tealBright w-16 shrink-0">
                {fmtRange(f)}
              </span>
              {f.entity && <span className="text-tealBright font-medium">{f.entity}</span>}
              <span className="truncate">{f.claim}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function fmtRange(f: TimelineFact): string {
  const a = f.applies_from_chapter;
  const b = f.applies_to_chapter;
  if (a != null && b != null) return `ch ${a}–${b}`;
  if (a != null) return `ch ${a}+`;
  if (b != null) return `–ch ${b}`;
  return "—";
}

function FactColumn({
  title,
  tone,
  facts,
  chapter,
  editId,
  onEdit,
  onSetBounds,
}: {
  title: string;
  tone: string;
  facts: TimelineFact[];
  chapter: number;
  editId: number | null;
  onEdit: (id: number | null) => void;
  onSetBounds: (factId: number, from: number | null) => void;
}) {
  return (
    <div className="space-y-1">
      <h3 className={`text-xs uppercase tracking-wide ${tone}`}>
        {title} · {facts.length}
      </h3>
      <ul className="space-y-1">
        {facts.map((f) => (
          <li key={f.id} className="card text-sm py-2">
            <div className="flex items-start gap-2">
              <div className="min-w-0">
                {f.entity && (
                  <span className="text-tealBright font-medium mr-1">{f.entity}</span>
                )}
                <span>{f.claim}</span>
              </div>
              <button
                className="ml-auto text-muted hover:text-tealBright text-xs shrink-0"
                title="Set the chapter this becomes known"
                onClick={() => onEdit(editId === f.id ? null : f.id)}
              >
                ✎ {f.applies_from_chapter != null ? `ch ${f.applies_from_chapter}` : "set"}
              </button>
            </div>
            {editId === f.id && (
              <div className="mt-2 flex items-center gap-2 text-xs">
                <span className="text-muted">known from chapter</span>
                <input
                  type="number"
                  min={1}
                  defaultValue={f.applies_from_chapter ?? chapter}
                  className="input w-20 py-1"
                  id={`ch-${f.id}`}
                />
                <button
                  className="btn btn-primary text-xs"
                  onClick={() => {
                    const el = document.getElementById(`ch-${f.id}`) as HTMLInputElement | null;
                    const v = el ? Number(el.value) : NaN;
                    onSetBounds(f.id, Number.isFinite(v) && v > 0 ? v : null);
                  }}
                >
                  Set
                </button>
                <button className="btn btn-ghost text-xs" onClick={() => onSetBounds(f.id, null)}>
                  Clear
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
