// Pill row of active pins for a story.

import { usePins, removePin } from "../pins.ts";

const basename = (p: string): string =>
  p.replace(/\\/g, "/").split("/").pop() ?? p;

export function PinnedContext({ storyId }: { storyId: number }) {
  const { pins } = usePins(storyId);
  if (pins.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 mb-3">
      {pins.map((p) => {
        const label = p.heading ? `${basename(p.path)} [${p.heading}]` : basename(p.path);
        return (
          <span
            key={p.id}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-mono border border-tealBright/40 bg-tealBright/10 text-tealBright max-w-xs"
            title={`${p.path}${p.heading ? ` :: ${p.heading}` : ""}`}
          >
            <span>📌</span>
            <span className="truncate">{label}</span>
            <button
              type="button"
              aria-label={`Remove pin ${label}`}
              onClick={() => removePin(storyId, p.id)}
              className="ml-1 text-muted hover:text-tealBright leading-none"
            >
              ×
            </button>
          </span>
        );
      })}
    </div>
  );
}
