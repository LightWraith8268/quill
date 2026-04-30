import { useEffect, useMemo, useState } from "react";
import { api, type StyleProfile } from "../api.ts";
import { MarkdownView } from "./MarkdownView.tsx";

const MAX_GENRES = 2;
const ACTIVE_KEY = "quill.activeStyle";

type Active = { base: string | null; genres: string[] };

function loadActive(): Active {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Active;
      if (v && typeof v === "object") return v;
    }
  } catch {
    /* noop */
  }
  return { base: null, genres: [] };
}

function saveActive(a: Active): void {
  localStorage.setItem(ACTIVE_KEY, JSON.stringify(a));
}

export function StyleBrowser() {
  const [bases, setBases] = useState<StyleProfile[]>([]);
  const [genres, setGenres] = useState<StyleProfile[]>([]);
  const [active, setActive] = useState<Active>(loadActive);
  const [content, setContent] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.styleList(), api.genreList()])
      .then(([s, g]) => {
        setBases(s.styles);
        setGenres(g.genres);
        setActive((cur) => {
          const next: Active = { ...cur };
          if (!next.base && s.styles.length > 0) next.base = s.styles[0]!.name;
          next.genres = next.genres.filter((n) =>
            g.genres.some((gp) => gp.name === n)
          );
          if (next.base && !s.styles.some((sp) => sp.name === next.base)) {
            next.base = s.styles[0]?.name ?? null;
          }
          saveActive(next);
          return next;
        });
      })
      .catch((e: Error) => setErr(e.message));
  }, []);

  useEffect(() => {
    if (!active.base) return;
    saveActive(active);
    api
      .styleCompose(active.base, active.genres)
      .then((r) => setContent(r.content))
      .catch((e: Error) => setErr(e.message));
  }, [active.base, active.genres]);

  const toggleGenre = (name: string) => {
    setActive((cur) => {
      if (cur.genres.includes(name)) {
        return { ...cur, genres: cur.genres.filter((g) => g !== name) };
      }
      if (cur.genres.length >= MAX_GENRES) {
        return { ...cur, genres: [...cur.genres.slice(1), name] };
      }
      return { ...cur, genres: [...cur.genres, name] };
    });
  };

  const activeLabel = useMemo(() => {
    const parts = [active.base ?? "—"];
    if (active.genres.length) parts.push(`+ ${active.genres.join(" + ")}`);
    return parts.join(" ");
  }, [active]);

  return (
    <div className="max-w-6xl mx-auto grid grid-cols-[260px,1fr] gap-4 h-full">
      <aside className="card overflow-auto space-y-5">
        <div>
          <h3 className="font-display text-lg mb-2">Base profile</h3>
          {bases.length === 0 && (
            <p className="text-muted text-sm">No profiles in <code>Styles/</code>.</p>
          )}
          <ul className="space-y-1">
            {bases.map((s) => (
              <li key={s.name}>
                <button
                  onClick={() => setActive((c) => ({ ...c, base: s.name }))}
                  className={`w-full text-left px-2 py-1.5 rounded text-sm ${
                    active.base === s.name
                      ? "bg-teal/30 text-bg dark:text-paper"
                      : "hover:bg-bg/10 dark:hover:bg-muted/10 text-muted"
                  }`}
                >
                  <div className="truncate">{s.name}</div>
                  <div className="text-xs text-muted">{(s.bytes / 1024).toFixed(1)} KB</div>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h3 className="font-display text-lg mb-1">Genres</h3>
          <p className="text-xs text-muted mb-2">
            Up to {MAX_GENRES}. Adding a 3rd drops the oldest.
          </p>
          {genres.length === 0 && (
            <p className="text-muted text-sm">
              No overlays in <code>Styles/genres/</code>.
            </p>
          )}
          <ul className="space-y-1">
            {genres.map((g) => {
              const on = active.genres.includes(g.name);
              return (
                <li key={g.name}>
                  <button
                    onClick={() => toggleGenre(g.name)}
                    className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center gap-2 ${
                      on
                        ? "bg-tealBright/20 text-bg dark:text-paper border border-tealBright/40"
                        : "hover:bg-bg/10 dark:hover:bg-muted/10 text-muted border border-transparent"
                    }`}
                  >
                    <span
                      className={`w-3 h-3 rounded-sm border ${
                        on
                          ? "bg-tealBright border-tealBright"
                          : "border-muted/50"
                      }`}
                    />
                    <span className="truncate flex-1">{g.name}</span>
                    <span className="text-xs text-muted">
                      {(g.bytes / 1024).toFixed(1)} KB
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </aside>

      <section className="card overflow-auto">
        {err && <div className="text-red-700 dark:text-red-300 text-sm mb-2">{err}</div>}
        {active.base && (
          <>
            <div className="flex items-baseline gap-2 mb-4">
              <h2 className="font-display text-2xl">{active.base}</h2>
              {active.genres.length > 0 && (
                <span className="text-tealBright italic text-sm">
                  + {active.genres.join(" + ")}
                </span>
              )}
            </div>
            <div className="text-xs text-muted mb-4">Active style: {activeLabel}</div>
            <MarkdownView content={content} />
          </>
        )}
      </section>
    </div>
  );
}
