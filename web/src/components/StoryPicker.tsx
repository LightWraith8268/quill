// Inline picker shown in TopBar. Lists discovered stories grouped by series.
// Clicking a story upserts it into DB then sets activeStoryId.

import { useEffect, useRef, useState } from "react";
import { api, type DiscoveredStory, type Story } from "../api.ts";

type Props = {
  activeStoryId: number | null;
  onPick: (story: Story) => void;
};

export function StoryPicker({ activeStoryId, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredStory[]>([]);
  const [stories, setStories] = useState<Story[]>([]);
  const [active, setActive] = useState<Story | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.storiesDiscover().then((r) => setDiscovered(r.stories)).catch(() => {});
    api.storiesList().then((r) => setStories(r.stories)).catch(() => {});
  }, []);

  useEffect(() => {
    if (activeStoryId) {
      api.storyGet(activeStoryId).then(setActive).catch(() => setActive(null));
    } else {
      setActive(null);
    }
  }, [activeStoryId]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const pick = async (d: DiscoveredStory) => {
    setBusy(d.path);
    try {
      const story = await api.storyCreate(d);
      setStories((cur) =>
        cur.some((s) => s.id === story.id) ? cur : [...cur, story]
      );
      setOpen(false);
      onPick(story);
    } finally {
      setBusy(null);
    }
  };

  // Group discovered by series
  const grouped = new Map<string, DiscoveredStory[]>();
  for (const d of discovered) {
    if (!grouped.has(d.series)) grouped.set(d.series, []);
    grouped.get(d.series)!.push(d);
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="btn btn-ghost min-w-[220px] justify-start text-left flex items-center gap-2"
      >
        <span className="text-tealBright">📖</span>
        <span className="truncate">
          {active
            ? `${active.series ?? ""} — ${active.name}`
            : "No story selected"}
        </span>
        <span className="ml-auto text-muted text-xs">▼</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 w-[420px] max-h-[70vh] overflow-auto card z-50 shadow-2xl">
          {grouped.size === 0 && (
            <p className="text-muted text-sm">No stories under <code>Books/</code>.</p>
          )}
          {[...grouped.entries()].map(([series, items]) => (
            <div key={series} className="mb-3">
              <div className="text-xs uppercase tracking-wide text-tealBright mb-1">
                {series}
              </div>
              <ul className="space-y-0.5">
                {items.map((d) => {
                  const known = stories.find((s) => s.path === d.path);
                  const isActive = known && known.id === activeStoryId;
                  return (
                    <li key={d.path}>
                      <button
                        onClick={() => pick(d)}
                        disabled={busy === d.path}
                        className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center gap-2 ${
                          isActive
                            ? "bg-teal/40 text-paper"
                            : "hover:bg-muted/10 text-paper"
                        }`}
                      >
                        <span className="truncate flex-1">{d.name}</span>
                        {known && (
                          <span className="text-xs text-muted">(saved)</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
