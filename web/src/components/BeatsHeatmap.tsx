// Per-chapter beats heatmap for a story. Renders a row per chapter with
// 4 colored cells: action / dialogue / emphasis / variance. Click chapter
// to navigate to file.

import { useEffect, useState } from "react";
import { api, type ChapterBeats } from "../api.ts";
import { goToVaultPath } from "../citations.ts";

type Props = { storyId: number };

function cell(value: number, max: number): string {
  const pct = Math.min(1, value / max);
  const hue = pct < 0.4 ? 200 : pct < 0.7 ? 40 : 0; // teal → amber → red
  return `hsl(${hue}, 70%, ${100 - 50 * pct}%)`;
}

export function BeatsHeatmap({ storyId }: Props) {
  const [chapters, setChapters] = useState<ChapterBeats[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .storyBeats(storyId)
      .then((r) => setChapters(r.chapters))
      .catch((e: Error) => setErr(e.message));
  }, [storyId]);

  if (err) return <div className="text-red-300 text-sm">{err}</div>;
  if (chapters.length === 0) {
    return <p className="text-muted text-sm">Outline + manuscript files needed for beats.</p>;
  }

  return (
    <div className="card space-y-2">
      <h3 className="font-display text-lg">Beats heatmap</h3>
      <p className="text-xs text-muted">
        Per chapter: action / dialogue / emphasis / sentence variance density.
        Brighter = denser. Click a row to open the file.
      </p>
      <div className="space-y-1 text-xs font-mono">
        <div className="flex gap-2 items-center">
          <div className="flex-1 truncate text-muted">chapter</div>
          <div className="w-12 text-center text-muted">act</div>
          <div className="w-12 text-center text-muted">dlg</div>
          <div className="w-12 text-center text-muted">emp</div>
          <div className="w-12 text-center text-muted">var</div>
          <div className="w-16 text-right text-muted">words</div>
        </div>
        {chapters.map((c) => (
          <button
            key={c.path}
            onClick={() => goToVaultPath(c.path)}
            className="w-full flex gap-2 items-center hover:bg-muted/10 p-1 rounded"
          >
            <div className="flex-1 truncate text-left">{c.title}</div>
            <div className="w-12 h-6 rounded" style={{ backgroundColor: cell(c.actionDensity, 1) }} />
            <div className="w-12 h-6 rounded" style={{ backgroundColor: cell(c.dialogueDensity, 1) }} />
            <div className="w-12 h-6 rounded" style={{ backgroundColor: cell(c.emphasisDensity, 1) }} />
            <div className="w-12 h-6 rounded" style={{ backgroundColor: cell(c.sentenceVariance, 200) }} />
            <div className="w-16 text-right">{c.words.toLocaleString()}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
