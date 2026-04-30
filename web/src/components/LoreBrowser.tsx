// Entity / wikilink browser. Shows all [[wiki targets]] across the vault with
// occurrence counts + backlink files. Click an entity → list of files that
// reference it.

import { useEffect, useMemo, useState } from "react";
import { api, type Entity } from "../api.ts";

export function LoreBrowser() {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState<Entity | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api
      .loreEntities()
      .then((r) => {
        setEntities(r.entities);
        setLoading(false);
      })
      .catch((e: Error) => {
        setErr(e.message);
        setLoading(false);
      });
  }, []);

  const filtered = useMemo(() => {
    if (!filter.trim()) return entities;
    const f = filter.toLowerCase();
    return entities.filter((e) => e.name.toLowerCase().includes(f));
  }, [entities, filter]);

  const followFile = async (path: string) => {
    // Surface chosen file in vault — open in new tab via deep link not implemented
    // Just copy path to clipboard + alert.
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      /* noop */
    }
  };

  return (
    <div className="grid grid-cols-[320px,1fr] gap-4 h-full max-w-[1500px] mx-auto">
      <aside className="card overflow-auto flex flex-col">
        <h3 className="font-display text-lg mb-2">
          Entities <span className="text-muted text-sm">({entities.length})</span>
        </h3>
        <input
          className="input mb-3"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {loading && <p className="text-muted text-sm">Scanning vault…</p>}
        {err && <p className="text-red-700 dark:text-red-300 text-sm">{err}</p>}
        <ul className="space-y-0.5 flex-1 overflow-auto">
          {filtered.map((e) => (
            <li key={e.name}>
              <button
                onClick={() => setActive(e)}
                className={`w-full text-left px-2 py-1 rounded text-sm flex items-center gap-2 ${
                  active?.name === e.name
                    ? "bg-teal/40 text-paper"
                    : "hover:bg-bg/10 dark:hover:bg-muted/10 text-bg dark:text-paper"
                }`}
              >
                <span className="truncate flex-1">{e.name}</span>
                <span className="text-xs text-muted">{e.occurrences}×</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="card overflow-auto">
        {!active && (
          <p className="text-muted text-sm">
            Pick an entity to see its backlinks.
          </p>
        )}
        {active && (
          <>
            <h2 className="font-display text-2xl mb-1">{active.name}</h2>
            <p className="text-sm text-muted mb-4">
              {active.occurrences} mention{active.occurrences === 1 ? "" : "s"} across {active.files.length} file{active.files.length === 1 ? "" : "s"}
            </p>
            <ul className="space-y-1">
              {active.files.map((f) => (
                <li
                  key={f.path}
                  className="flex items-center gap-2 text-xs font-mono p-1.5 border border-muted/20 rounded"
                >
                  <span className="text-tealBright">{f.count}×</span>
                  <span className="truncate flex-1">{f.path}</span>
                  <button
                    onClick={() => followFile(f.path)}
                    className="btn btn-ghost text-xs"
                  >
                    copy path
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
