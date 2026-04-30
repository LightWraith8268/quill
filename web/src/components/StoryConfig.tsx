// Inline story-config bar shown above chat. Lets user pick base style + up to 2 genres
// for the active story; persists via PATCH /api/stories/:id.

import { useEffect, useState } from "react";
import { api, type Story, type StyleProfile } from "../api.ts";

const MAX_GENRES = 2;

type Props = {
  story: Story;
  onUpdated: (s: Story) => void;
};

export function StoryConfig({ story, onUpdated }: Props) {
  const [bases, setBases] = useState<StyleProfile[]>([]);
  const [genres, setGenres] = useState<StyleProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);

  useEffect(() => {
    api.styleList().then((r) => setBases(r.styles)).catch(() => {});
    api.genreList().then((r) => setGenres(r.genres)).catch(() => {});
  }, []);

  const setBase = async (name: string) => {
    setBusy(true);
    try {
      const updated = await api.storyPatch(story.id, { active_style: name });
      onUpdated(updated);
    } finally {
      setBusy(false);
    }
  };

  const doExport = async () => {
    setExporting(true);
    setExportNote(null);
    try {
      const { filename, bytes } = await api.exportStory(story.id);
      const kb = (bytes / 1024).toFixed(1);
      setExportNote(`Saved ${filename} (${kb} KB)`);
      setTimeout(() => setExportNote(null), 4000);
    } catch (e) {
      setExportNote(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
      setTimeout(() => setExportNote(null), 6000);
    } finally {
      setExporting(false);
    }
  };

  const toggleGenre = async (name: string) => {
    let next: string[];
    if (story.active_genres.includes(name)) {
      next = story.active_genres.filter((g) => g !== name);
    } else if (story.active_genres.length >= MAX_GENRES) {
      next = [...story.active_genres.slice(1), name];
    } else {
      next = [...story.active_genres, name];
    }
    setBusy(true);
    try {
      const updated = await api.storyPatch(story.id, { active_genres: next });
      onUpdated(updated);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card flex flex-wrap items-center gap-3 text-sm">
      <div className="font-display text-lg">
        {story.series && <span className="text-tealBright">{story.series}</span>} —{" "}
        {story.name}
      </div>
      <div className="flex items-center gap-2 ml-2">
        <span className="text-muted text-xs">Style</span>
        <select
          className="input"
          value={story.active_style ?? ""}
          onChange={(e) => setBase(e.target.value)}
          disabled={busy}
        >
          <option value="">(none)</option>
          {bases.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-muted text-xs">Genres ({MAX_GENRES} max)</span>
        <div className="flex gap-1 flex-wrap">
          {genres.map((g) => {
            const on = story.active_genres.includes(g.name);
            return (
              <button
                key={g.name}
                disabled={busy}
                onClick={() => toggleGenre(g.name)}
                className={`px-2 py-0.5 rounded text-xs border ${
                  on
                    ? "bg-tealBright/20 border-tealBright/60 text-bg dark:text-paper"
                    : "border-muted/30 text-muted hover:border-muted/60"
                }`}
              >
                {g.name}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex items-center gap-2 ml-auto" title="Export this story as a JSON bundle">
        <button
          onClick={doExport}
          disabled={exporting}
          className="px-2 py-0.5 rounded text-xs border border-tealBright/60 text-tealBright hover:bg-tealBright/10 disabled:opacity-50"
        >
          {exporting ? "Exporting…" : "Export"}
        </button>
        {exportNote && <span className="text-xs text-muted">{exportNote}</span>}
      </div>
    </div>
  );
}
