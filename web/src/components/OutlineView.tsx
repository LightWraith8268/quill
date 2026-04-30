// Outline / plot board for a story. Two view modes: list (tree) and kanban
// (chapters as columns of scene cards). Click a node to edit summary,
// status, target words. Drag to reorder within parent (kanban).

import { useEffect, useState } from "react";
import { api, type OutlineNode } from "../api.ts";

type Props = { storyId: number };
type ViewMode = "list" | "board" | "reading";

const STATUS_COLOR: Record<string, string> = {
  outlined: "bg-muted/30",
  drafted: "bg-tealBright/30",
  revised: "bg-teal/40",
  locked: "bg-emerald-500/30",
};

export function OutlineView({ storyId }: Props) {
  const [nodes, setNodes] = useState<OutlineNode[]>([]);
  const [view, setView] = useState<ViewMode>("list");
  const [editing, setEditing] = useState<OutlineNode | null>(null);
  const [creating, setCreating] = useState<{ parentId: number | null; kind: OutlineNode["kind"] } | null>(null);
  const [reading, setReading] = useState<{ parts: { title: string; content: string; path: string }[] } | null>(null);
  const [readingBusy, setReadingBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const r = await api.outlineList(storyId);
      setNodes(r.nodes);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  useEffect(() => {
    refresh();
  }, [storyId]);

  const acts = nodes.filter((n) => n.parent_id === null);
  const childrenOf = (id: number): OutlineNode[] =>
    nodes.filter((n) => n.parent_id === id).sort((a, b) => a.sort_order - b.sort_order);

  const startReading = async () => {
    setReadingBusy(true);
    setErr(null);
    try {
      const r = await api.readingPass(storyId);
      setReading({
        parts: r.parts.map((p) => ({ title: p.title, content: p.content, path: p.path })),
      });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setReadingBusy(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto space-y-4">
      <div className="card flex flex-wrap items-center gap-2">
        <h2 className="font-display text-2xl">Outline</h2>
        <div className="flex gap-1 ml-2">
          {(["list", "board", "reading"] as ViewMode[]).map((m) => (
            <button
              key={m}
              onClick={() => {
                setView(m);
                if (m === "reading" && !reading) startReading();
              }}
              className={`btn ${view === m ? "btn-primary" : "btn-ghost"} text-xs capitalize`}
            >
              {m}
            </button>
          ))}
        </div>
        <button
          onClick={() => setCreating({ parentId: null, kind: "act" })}
          className="btn btn-ghost text-xs ml-auto"
        >
          + Act
        </button>
        <div className="flex gap-1">
          <button
            onClick={() => api.compileStory(storyId, "md").catch((e) => setErr((e as Error).message))}
            className="btn btn-ghost text-xs"
          >
            ⇩ md
          </button>
          <button
            onClick={() => api.compileStory(storyId, "html").catch((e) => setErr((e as Error).message))}
            className="btn btn-ghost text-xs"
          >
            ⇩ html
          </button>
          <button
            onClick={() => api.compileStory(storyId, "docx").catch((e) => setErr((e as Error).message))}
            className="btn btn-ghost text-xs"
            title="Requires pandoc on PATH"
          >
            ⇩ docx
          </button>
        </div>
      </div>

      {err && (
        <div className="bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200 text-sm p-3 rounded">
          {err}
        </div>
      )}

      {view === "list" && (
        <div className="space-y-2">
          {acts.length === 0 && (
            <p className="text-muted text-sm">
              No outline yet. Click "+ Act" above to start. Acts contain chapters; chapters contain scenes.
            </p>
          )}
          {acts.map((a) => (
            <div key={a.id} className="card">
              <NodeRow node={a} onEdit={() => setEditing(a)} />
              <div className="ml-6 mt-2 space-y-1.5">
                {childrenOf(a.id).map((ch) => (
                  <div key={ch.id}>
                    <NodeRow node={ch} onEdit={() => setEditing(ch)} />
                    <div className="ml-6 mt-1 space-y-1">
                      {childrenOf(ch.id).map((sc) => (
                        <NodeRow key={sc.id} node={sc} onEdit={() => setEditing(sc)} compact />
                      ))}
                      <button
                        onClick={() => setCreating({ parentId: ch.id, kind: "scene" })}
                        className="text-xs text-muted hover:text-tealBright"
                      >
                        + Scene
                      </button>
                    </div>
                  </div>
                ))}
                <button
                  onClick={() => setCreating({ parentId: a.id, kind: "chapter" })}
                  className="text-xs text-muted hover:text-tealBright"
                >
                  + Chapter
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {view === "board" && (
        <div className="overflow-x-auto">
          <div className="flex gap-3 min-w-max">
            {acts.flatMap((a) => childrenOf(a.id)).map((ch) => (
              <div key={ch.id} className="card w-72 flex-shrink-0">
                <div className="flex items-baseline gap-2 mb-2">
                  <h3 className="font-display text-lg truncate">{ch.title}</h3>
                  <span className="text-xs text-muted ml-auto">{ch.status}</span>
                </div>
                <div className="space-y-1.5">
                  {childrenOf(ch.id).map((sc) => (
                    <button
                      key={sc.id}
                      onClick={() => setEditing(sc)}
                      className={`w-full text-left p-2 rounded text-xs ${
                        STATUS_COLOR[sc.status] ?? "bg-muted/20"
                      } border border-muted/30 hover:border-tealBright`}
                    >
                      <div className="font-medium truncate">{sc.title}</div>
                      {sc.summary && (
                        <div className="text-xs text-muted mt-0.5 line-clamp-2">{sc.summary}</div>
                      )}
                      <div className="text-xs text-muted mt-1 flex gap-2">
                        <span>{sc.status}</span>
                        {sc.target_words ? <span>~{sc.target_words}w</span> : null}
                      </div>
                    </button>
                  ))}
                  <button
                    onClick={() => setCreating({ parentId: ch.id, kind: "scene" })}
                    className="w-full text-xs text-muted hover:text-tealBright py-1"
                  >
                    + Scene
                  </button>
                </div>
              </div>
            ))}
            {acts.flatMap((a) => childrenOf(a.id)).length === 0 && (
              <p className="text-muted text-sm">Add chapters to populate the board.</p>
            )}
          </div>
        </div>
      )}

      {view === "reading" && (
        <div className="card max-w-3xl mx-auto">
          {readingBusy && <p className="text-muted">Loading reading pass…</p>}
          {reading && reading.parts.length === 0 && (
            <p className="text-muted">No manuscript files found for this story.</p>
          )}
          {reading?.parts.map((p) => (
            <div key={p.path} className="mb-8">
              <h2 className="font-display text-2xl border-b border-muted/20 pb-2 mb-4">
                {p.title}
              </h2>
              <pre className="whitespace-pre-wrap font-ui leading-relaxed text-base">
                {p.content}
              </pre>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <NodeEditor
          node={editing}
          onClose={() => setEditing(null)}
          onSaved={async (n) => {
            setEditing(null);
            if (n) await refresh();
          }}
        />
      )}
      {creating && (
        <NodeCreator
          storyId={storyId}
          parentId={creating.parentId}
          defaultKind={creating.kind}
          onClose={() => setCreating(null)}
          onCreated={async () => {
            setCreating(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function NodeRow({
  node,
  onEdit,
  compact,
}: {
  node: OutlineNode;
  onEdit: () => void;
  compact?: boolean;
}) {
  return (
    <button
      onClick={onEdit}
      className={`w-full text-left flex items-baseline gap-2 ${compact ? "" : "py-1"}`}
    >
      <span className="text-xs text-muted uppercase font-mono w-16">{node.kind}</span>
      <span className={`font-${compact ? "ui" : "display"} ${compact ? "text-sm" : "text-lg"} truncate`}>
        {node.title}
      </span>
      <span className={`text-xs px-1.5 py-0.5 rounded ml-auto ${STATUS_COLOR[node.status]}`}>
        {node.status}
      </span>
    </button>
  );
}

function NodeEditor({
  node,
  onClose,
  onSaved,
}: {
  node: OutlineNode;
  onClose: () => void;
  onSaved: (n: OutlineNode | null) => void;
}) {
  const [title, setTitle] = useState(node.title);
  const [summary, setSummary] = useState(node.summary ?? "");
  const [status, setStatus] = useState(node.status);
  const [targetWords, setTargetWords] = useState(node.target_words ?? 0);
  const [manuscriptPath, setManuscriptPath] = useState(node.manuscript_path ?? "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const updated = await api.outlineUpdate(node.id, {
        title,
        summary: summary || null,
        status,
        target_words: targetWords || null,
        manuscript_path: manuscriptPath || null,
      });
      onSaved(updated);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete ${node.kind} "${node.title}"? Children become orphans.`)) return;
    setBusy(true);
    try {
      await api.outlineDelete(node.id);
      onSaved(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center pt-[8vh] p-3">
      <div className="card w-full max-w-2xl max-h-[80vh] overflow-auto space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-xl capitalize">{node.kind}</h2>
          <button onClick={onClose} className="btn btn-ghost text-xs ml-auto">Close</button>
        </div>
        <input className="input w-full" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" />
        <textarea
          className="input w-full font-ui resize-none"
          rows={6}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Summary / beat description"
        />
        <div className="flex flex-wrap gap-3 items-center">
          <label className="text-xs text-muted flex items-center gap-2">
            Status
            <select
              className="input"
              value={status}
              onChange={(e) => setStatus(e.target.value as OutlineNode["status"])}
            >
              <option value="outlined">outlined</option>
              <option value="drafted">drafted</option>
              <option value="revised">revised</option>
              <option value="locked">locked</option>
            </select>
          </label>
          <label className="text-xs text-muted flex items-center gap-2">
            Target words
            <input
              type="number"
              className="input w-24"
              value={targetWords}
              onChange={(e) => setTargetWords(Number(e.target.value))}
            />
          </label>
        </div>
        <input
          className="input w-full"
          value={manuscriptPath}
          onChange={(e) => setManuscriptPath(e.target.value)}
          placeholder="Manuscript file path (Books/Series/Story/Chapter1.md)"
        />
        <div className="flex gap-2">
          <button onClick={remove} disabled={busy} className="btn btn-ghost text-xs text-red-500">
            Delete
          </button>
          <button onClick={onClose} className="btn btn-ghost ml-auto">Cancel</button>
          <button onClick={save} disabled={busy} className="btn btn-primary">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function NodeCreator({
  storyId,
  parentId,
  defaultKind,
  onClose,
  onCreated,
}: {
  storyId: number;
  parentId: number | null;
  defaultKind: OutlineNode["kind"];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<OutlineNode["kind"]>(defaultKind);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await api.outlineCreate(storyId, { parentId, kind, title: title.trim() });
      onCreated();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center pt-[10vh] p-3">
      <div className="card w-full max-w-md space-y-3">
        <h2 className="font-display text-xl">New {kind}</h2>
        <select
          className="input w-full"
          value={kind}
          onChange={(e) => setKind(e.target.value as OutlineNode["kind"])}
        >
          <option value="act">Act</option>
          <option value="chapter">Chapter</option>
          <option value="scene">Scene</option>
          <option value="note">Note</option>
        </select>
        <input
          autoFocus
          className="input w-full"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
          }}
        />
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="btn btn-ghost">Cancel</button>
          <button onClick={create} disabled={busy || !title.trim()} className="btn btn-primary">
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
