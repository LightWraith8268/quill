// Structure view: story-shape analysis from the knowledge layer. Pacing
// (chapter word-count distribution + >1.5σ outliers) loads automatically since
// it's a pure computation; beat-sheet alignment is gated behind a button
// because it runs the LLM over the manuscript. Scoped to the active story.

import { useEffect, useState } from "react";
import {
  api,
  type BeatAlignment,
  type BeatStatus,
  type PacingReport,
} from "../api.ts";

const TEMPLATES: { id: string; label: string }[] = [
  { id: "save-the-cat", label: "Save the Cat" },
  { id: "hero-journey", label: "Hero's Journey" },
  { id: "three-act", label: "Three-Act" },
];

const STATUS_TONE: Record<BeatStatus, string> = {
  present: "text-tealBright",
  weak: "text-amber-500",
  missing: "text-muted",
};
const STATUS_DOT: Record<BeatStatus, string> = {
  present: "bg-tealBright",
  weak: "bg-amber-500",
  missing: "bg-muted/40",
};

export function StructureBrowser({ storyId }: { storyId: number }) {
  const [pacing, setPacing] = useState<PacingReport | null>(null);
  const [pacingBusy, setPacingBusy] = useState(false);
  const [beats, setBeats] = useState<BeatAlignment | null>(null);
  const [beatsBusy, setBeatsBusy] = useState(false);
  const [template, setTemplate] = useState("save-the-cat");
  const [err, setErr] = useState<string | null>(null);

  const loadPacing = () => {
    setPacingBusy(true);
    setErr(null);
    api
      .kbPacing(storyId)
      .then(setPacing)
      .catch((e: Error) => setErr(e.message))
      .finally(() => setPacingBusy(false));
  };

  useEffect(() => {
    setPacing(null);
    setBeats(null);
    loadPacing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storyId]);

  const loadBeats = async () => {
    if (beatsBusy) return;
    setBeatsBusy(true);
    setErr(null);
    try {
      setBeats(await api.kbBeats(storyId, template));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBeatsBusy(false);
    }
  };

  const maxWords = pacing
    ? Math.max(1, ...pacing.chapters.map((c) => c.words))
    : 1;

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      {err && (
        <div className="bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200 text-sm p-3 rounded">
          {err}
        </div>
      )}

      {/* Pacing */}
      <div className="card space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-display text-lg">Pacing</h3>
          {pacing && (
            <span className="text-xs text-muted">
              mean {pacing.mean.toLocaleString()} words · σ{" "}
              {pacing.stdev.toLocaleString()} ·{" "}
              {pacing.outliers.length === 0 ? (
                <span className="text-tealBright">no outliers</span>
              ) : (
                <span className="text-amber-500">
                  {pacing.outliers.length} outlier
                  {pacing.outliers.length === 1 ? "" : "s"}
                </span>
              )}
            </span>
          )}
          <button
            className="btn btn-ghost text-xs ml-auto"
            onClick={loadPacing}
            disabled={pacingBusy}
          >
            {pacingBusy ? "…" : "Refresh"}
          </button>
        </div>
        {!pacing && pacingBusy && (
          <p className="text-muted text-sm">Measuring chapters…</p>
        )}
        {pacing && pacing.chapters.length === 0 && (
          <p className="text-muted text-sm">
            No chapters found — add an outline or manuscript files first.
          </p>
        )}
        {pacing && pacing.chapters.length > 0 && (
          <ul className="space-y-1">
            {pacing.chapters.map((c, i) => (
              <li key={i} className="flex items-center gap-2 text-xs">
                <span className="w-40 shrink-0 truncate" title={c.title}>
                  {c.title}
                </span>
                <span className="flex-1 h-3 rounded bg-bg/10 dark:bg-muted/10 overflow-hidden">
                  <span
                    className={`block h-full ${c.outlier ? "bg-amber-500" : "bg-teal"}`}
                    style={{ width: `${(c.words / maxWords) * 100}%` }}
                  />
                </span>
                <span className="w-28 shrink-0 text-right font-mono text-muted">
                  {c.words.toLocaleString()}w
                  {c.outlier && (
                    <span className="text-amber-500"> · z{c.z.toFixed(1)}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Beat-sheet alignment */}
      <div className="card space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-display text-lg">Beat sheet</h3>
          <select
            className="input text-xs py-1"
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            disabled={beatsBusy}
          >
            {TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <button
            className="btn btn-primary text-xs ml-auto"
            onClick={loadBeats}
            disabled={beatsBusy}
            title="Classify the manuscript against this structure (uses the LLM)"
          >
            {beatsBusy ? "Analyzing…" : beats ? "Re-analyze" : "Analyze beats"}
          </button>
        </div>

        {beats && (
          <>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted">{beats.template} coverage</span>
              <span className="flex-1 h-2 rounded bg-bg/10 dark:bg-muted/10 overflow-hidden">
                <span
                  className="block h-full bg-tealBright"
                  style={{ width: `${Math.round(beats.coverage * 100)}%` }}
                />
              </span>
              <span className="font-mono text-tealBright">
                {Math.round(beats.coverage * 100)}%
              </span>
            </div>
            <ul className="space-y-1">
              {beats.beats.map((b, i) => (
                <li key={i} className="text-xs p-2 rounded border border-muted/20">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[b.status]}`} />
                    <span className="font-medium">{b.beat}</span>
                    <span className={`uppercase text-[10px] ${STATUS_TONE[b.status]}`}>
                      {b.status}
                    </span>
                    {b.chapter && (
                      <span className="ml-auto text-muted truncate max-w-[45%]">
                        {b.chapter}
                      </span>
                    )}
                  </div>
                  {b.note && <div className="mt-0.5 text-muted">{b.note}</div>}
                </li>
              ))}
            </ul>
          </>
        )}
        {!beats && !beatsBusy && (
          <p className="text-muted text-sm">
            Map your chapters onto a structure template to see which beats land,
            which are weak, and which are missing.
          </p>
        )}
      </div>
    </div>
  );
}
