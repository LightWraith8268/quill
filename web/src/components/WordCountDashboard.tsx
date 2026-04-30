import { useEffect, useState } from "react";
import { api, type StoryWordCount, type StoryWordCountFile } from "../api.ts";
import { goToVaultPath } from "../citations.ts";

export function WordCountDashboard({ storyId }: { storyId: number }) {
  const [data, setData] = useState<StoryWordCount | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = () => {
    setLoading(true);
    setErr(null);
    api
      .storyWordCount(storyId)
      .then((r) => setData(r))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storyId]);

  const hasAnyTimeline =
    data?.files.some((f) => f.timeline.length > 0) ?? false;

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-lg">Word count & pacing</h3>
        <button
          onClick={refresh}
          disabled={loading}
          className="btn btn-ghost text-sm"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {err && (
        <div className="text-sm text-red-700 dark:text-red-300">{err}</div>
      )}

      {data && (
        <>
          <div className="text-center py-2">
            <div className="font-display text-4xl text-tealBright">
              {data.totalWords.toLocaleString()}
            </div>
            <div className="text-xs text-muted uppercase tracking-wide">
              Total words across {data.files.length} file
              {data.files.length === 1 ? "" : "s"}
            </div>
          </div>

          {data.files.length === 0 ? (
            <p className="text-muted text-sm text-center py-4">
              No markdown files found under this story.
            </p>
          ) : !hasAnyTimeline ? (
            <p className="text-muted text-sm text-center py-4">
              No snapshots recorded yet. Save drafts of manuscript files to
              build a pacing timeline.
            </p>
          ) : null}

          {data.files.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase text-muted border-b border-bg/10 dark:border-muted/20">
                    <th className="py-2 pr-2">File</th>
                    <th className="py-2 px-2 text-right">Words</th>
                    <th className="py-2 px-2 text-right">Δ</th>
                    <th className="py-2 pl-2">Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {data.files.map((f) => (
                    <FileRow key={f.path} file={f} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {!data && !err && (
        <p className="text-muted text-sm">Loading…</p>
      )}
    </div>
  );
}

function FileRow({ file }: { file: StoryWordCountFile }) {
  const last = file.timeline.length > 0 ? file.timeline[file.timeline.length - 1] : null;
  const delta = last ? file.currentWords - last.words : null;
  const display = file.path.replace(/^Books\//, "");
  return (
    <tr className="border-b border-bg/5 dark:border-muted/10 hover:bg-paper/30 dark:hover:bg-bg/40">
      <td className="py-2 pr-2">
        <button
          onClick={() => goToVaultPath(file.path)}
          className="text-left hover:text-tealBright underline-offset-2 hover:underline font-mono text-xs break-all"
          title={file.path}
        >
          {display}
        </button>
      </td>
      <td className="py-2 px-2 text-right font-mono">
        {file.currentWords.toLocaleString()}
      </td>
      <td className="py-2 px-2 text-right font-mono text-xs">
        {delta === null ? (
          <span className="text-muted">—</span>
        ) : delta > 0 ? (
          <span className="text-green-700 dark:text-green-300">
            +{delta.toLocaleString()}
          </span>
        ) : delta < 0 ? (
          <span className="text-red-700 dark:text-red-300">
            {delta.toLocaleString()}
          </span>
        ) : (
          <span className="text-muted">0</span>
        )}
      </td>
      <td className="py-2 pl-2">
        <Sparkline
          values={[
            ...file.timeline.map((t) => t.words),
            file.currentWords,
          ]}
        />
      </td>
    </tr>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const W = 100;
  const H = 30;
  if (values.length < 2) {
    return (
      <span className="text-muted text-xs font-mono">
        {values.length === 1 ? "single point" : "—"}
      </span>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = W / (values.length - 1);
  const points = values
    .map((v, i) => {
      const x = i * stepX;
      const y = H - ((v - min) / span) * (H - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="text-tealBright"
      role="img"
      aria-label="Word-count trend"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
