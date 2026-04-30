import { useEffect, useState } from "react";
import { api, type CharacterDef } from "../api.ts";
import { MarkdownView } from "./MarkdownView.tsx";

type Props = {
  defaultSeries?: string | null;
};

export function CharacterTimeline({ defaultSeries }: Props) {
  const [seriesList, setSeriesList] = useState<{ series: string; characterCount: number }[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [characters, setCharacters] = useState<CharacterDef[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .charactersList()
      .then((r) => {
        setSeriesList(r.series);
        const initial =
          (defaultSeries && r.series.find((s) => s.series === defaultSeries)?.series) ??
          r.series[0]?.series ??
          null;
        setActive(initial);
      })
      .catch((e: Error) => setErr(e.message));
  }, [defaultSeries]);

  useEffect(() => {
    if (!active) {
      setCharacters([]);
      return;
    }
    api
      .charactersForSeries(active)
      .then((r) => {
        setCharacters(r.characters);
        setExpanded(new Set(r.characters.slice(0, 1).map((c) => c.name)));
      })
      .catch((e: Error) => setErr(e.message));
  }, [active]);

  const toggle = (name: string) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <div className="card flex flex-wrap items-center gap-3">
        <h2 className="font-display text-2xl">Characters</h2>
        <select
          className="input ml-auto"
          value={active ?? ""}
          onChange={(e) => setActive(e.target.value || null)}
        >
          <option value="">Pick a series…</option>
          {seriesList.map((s) => (
            <option key={s.series} value={s.series}>
              {s.series} ({s.characterCount})
            </option>
          ))}
        </select>
      </div>

      {err && (
        <div className="bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200 text-sm p-3 rounded">
          {err}
        </div>
      )}

      {!active && (
        <p className="text-muted text-sm">No CHARACTER_BIBLE.md found in any series.</p>
      )}

      {characters.map((c) => {
        const open = expanded.has(c.name);
        return (
          <div key={c.name} className="card">
            <button
              onClick={() => toggle(c.name)}
              className="w-full text-left flex items-baseline gap-3"
            >
              <h3 className="font-display text-xl">{c.name}</h3>
              {c.role && <span className="text-sm text-muted truncate">{c.role}</span>}
              <span className="ml-auto text-xs text-muted">{open ? "▾" : "▸"}</span>
            </button>
            {open && (
              <div className="mt-3 space-y-3 text-sm">
                {c.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {c.tags.map((t) => (
                      <span
                        key={t}
                        className="px-1.5 py-0.5 text-xs rounded border border-muted/30 font-mono"
                      >
                        #{t}
                      </span>
                    ))}
                  </div>
                )}
                {c.voiceSummary && <p className="italic">{c.voiceSummary}</p>}
                {c.agePerBook.length > 0 && (
                  <div className="flex flex-wrap gap-2 text-xs font-mono">
                    {c.agePerBook.map((a) => (
                      <span
                        key={a.book}
                        className="px-2 py-1 rounded bg-tealBright/10 border border-tealBright/30"
                      >
                        {a.book}: {a.age}
                      </span>
                    ))}
                  </div>
                )}
                {c.arc.length > 0 && (
                  <div>
                    <h4 className="text-xs uppercase tracking-wide text-muted mb-1">Arc</h4>
                    <div className="grid md:grid-cols-3 gap-3">
                      {c.arc.map((a) => (
                        <div
                          key={a.book}
                          className="p-3 border border-muted/20 rounded text-xs"
                        >
                          <div className="font-mono text-tealBright mb-1">{a.book}</div>
                          <ul className="list-disc pl-4 space-y-0.5">
                            {a.beats.map((b, i) => (
                              <li key={i}>{b}</li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {c.coreDrives.length > 0 && (
                  <div>
                    <h4 className="text-xs uppercase tracking-wide text-muted mb-1">Core drives</h4>
                    <ul className="list-disc pl-5 space-y-0.5">
                      {c.coreDrives.map((d, i) => (
                        <li key={i}>{d}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {c.relationships.length > 0 && (
                  <div>
                    <h4 className="text-xs uppercase tracking-wide text-muted mb-1">Relationships</h4>
                    <ul className="space-y-1">
                      {c.relationships.map((r) => (
                        <li key={r.partner} className="text-xs">
                          <span className="text-tealBright font-mono mr-2">{r.partner}</span>
                          {r.description}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {c.writingTics.length > 0 && (
                  <div>
                    <h4 className="text-xs uppercase tracking-wide text-muted mb-1">Writing tics</h4>
                    <ul className="list-disc pl-5 space-y-0.5">
                      {c.writingTics.map((t, i) => (
                        <li key={i}>{t}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {c.sections.length > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted">
                      Other sections ({c.sections.length})
                    </summary>
                    <div className="mt-2 space-y-3">
                      {c.sections.map((s) => (
                        <div key={s.heading}>
                          <div className="text-tealBright text-xs mb-1">{s.heading}</div>
                          <MarkdownView content={s.content} />
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
