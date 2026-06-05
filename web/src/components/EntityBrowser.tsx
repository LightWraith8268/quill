// Entity graph browser: list the series' canon entities, expand one to see its
// relationships (typed edges), its facts (by weight), and each fact's change
// history. The graph + facts come from the knowledge layer; lazy-loaded.

import { useEffect, useState } from "react";
import {
  api,
  type FactHistoryRow,
  type GraphEdge,
  type GraphEntity,
  type GraphFact,
} from "../api.ts";

const pretty = (w?: string | null) => (w ? w.replace(/_/g, " ") : "");

export function EntityBrowser({ storyId }: { storyId: number }) {
  const [entities, setEntities] = useState<GraphEntity[] | null>(null);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [filter, setFilter] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const [facts, setFacts] = useState<Record<number, GraphFact[]>>({});
  const [hist, setHist] = useState<Record<number, FactHistoryRow[]>>({});
  const [openFact, setOpenFact] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setEntities(null);
    setEdges([]);
    setOpenId(null);
    setFacts({});
    setHist({});
    setOpenFact(null);
    api
      .kbGraph(storyId)
      .then((r) => {
        setEntities(r.entities);
        setEdges(r.edges);
      })
      .catch((e: Error) => setErr(e.message));
  }, [storyId]);

  const toggleEntity = async (id: number) => {
    if (openId === id) {
      setOpenId(null);
      return;
    }
    setOpenId(id);
    setOpenFact(null);
    if (!facts[id]) {
      try {
        const r = await api.kbEntityFacts(storyId, id);
        setFacts((f) => ({ ...f, [id]: r.facts }));
      } catch (e) {
        setErr((e as Error).message);
      }
    }
  };

  const toggleFactHistory = async (fid: number) => {
    if (openFact === fid) {
      setOpenFact(null);
      return;
    }
    setOpenFact(fid);
    if (!hist[fid]) {
      try {
        const r = await api.kbFactHistory(storyId, fid);
        setHist((h) => ({ ...h, [fid]: r.history }));
      } catch (e) {
        setErr((e as Error).message);
      }
    }
  };

  const edgesFor = (id: number) => edges.filter((e) => e.src === id || e.dst === id);

  const f = filter.trim().toLowerCase();
  const list = (entities ?? []).filter(
    (e) =>
      !f ||
      e.name.toLowerCase().includes(f) ||
      e.aliases.some((a) => a.toLowerCase().includes(f))
  );

  return (
    <div className="space-y-3">
      {err && (
        <div className="bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200 text-sm p-3 rounded">
          {err}
        </div>
      )}
      {!entities && <p className="text-muted text-sm">Loading graph…</p>}
      {entities && entities.length === 0 && (
        <p className="text-muted text-sm">
          No entities yet — extract canon first.
        </p>
      )}
      {entities && entities.length > 0 && (
        <>
          <input
            className="input w-full"
            placeholder={`Filter ${entities.length} entit${entities.length === 1 ? "y" : "ies"}…`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <ul className="space-y-1">
            {list.map((ent) => {
              const open = openId === ent.id;
              const rels = edgesFor(ent.id);
              const entFacts = facts[ent.id];
              return (
                <li key={ent.id} className="card py-2">
                  <button
                    className="w-full text-left flex items-center gap-2"
                    onClick={() => toggleEntity(ent.id)}
                  >
                    <span className="text-muted">{open ? "▾" : "▸"}</span>
                    <span className="text-tealBright font-medium">{ent.name}</span>
                    <span className="text-[10px] uppercase text-muted">{ent.kind}</span>
                    {ent.aliases.length > 0 && (
                      <span className="text-[11px] text-muted truncate">
                        aka {ent.aliases.join(", ")}
                      </span>
                    )}
                    <span className="ml-auto text-[11px] text-muted shrink-0">
                      {ent.facts} fact{ent.facts === 1 ? "" : "s"} · {rels.length}{" "}
                      rel{rels.length === 1 ? "" : "s"}
                    </span>
                  </button>

                  {open && (
                    <div className="mt-2 pl-5 space-y-2">
                      {rels.length > 0 && (
                        <div className="text-xs space-y-0.5">
                          {rels.map((e, i) => {
                            const out = e.src === ent.id;
                            const other = out ? e.dstName : e.srcName;
                            return (
                              <div key={i} className="text-muted">
                                {out ? "" : "← "}
                                <span className="text-bg dark:text-paper">
                                  {e.relType.replace(/_/g, " ")}
                                </span>
                                {out ? " → " : " "}
                                <span className="text-tealBright">{other}</span>
                                {e.description ? ` · ${e.description}` : ""}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {!entFacts && <p className="text-xs text-muted">Loading facts…</p>}
                      {entFacts?.length === 0 && (
                        <p className="text-xs text-muted">No facts recorded.</p>
                      )}
                      <ul className="space-y-1">
                        {(entFacts ?? []).map((fact) => (
                          <li
                            key={fact.id}
                            className="text-xs border-l-2 border-muted/20 pl-2"
                          >
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] uppercase text-muted">
                                {pretty(fact.canon_weight)}
                              </span>
                              <button
                                className="ml-auto text-tealBright/80 hover:text-tealBright"
                                onClick={() => toggleFactHistory(fact.id)}
                              >
                                {openFact === fact.id ? "hide history" : "history"}
                              </button>
                            </div>
                            <div>{fact.claim}</div>
                            {openFact === fact.id && (
                              <div className="mt-1 font-mono text-[11px] text-muted space-y-0.5">
                                {!hist[fact.id] && <div>loading…</div>}
                                {hist[fact.id]?.length === 0 && (
                                  <div>no recorded changes</div>
                                )}
                                {(hist[fact.id] ?? []).map((h, i) => (
                                  <div key={i}>
                                    {new Date(h.at).toLocaleString()} ·{" "}
                                    {h.change_type}
                                    {h.prev_weight || h.new_weight
                                      ? ` (${pretty(h.prev_weight) || "—"} → ${pretty(h.new_weight) || "—"})`
                                      : ""}
                                    {h.actor ? ` · ${h.actor}` : ""}
                                  </div>
                                ))}
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
