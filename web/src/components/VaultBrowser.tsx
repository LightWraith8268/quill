// Read-only vault tree + file viewer with frontmatter, wikilink resolution,
// and per-file draft snapshots.

import { useEffect, useMemo, useState } from "react";
import {
  api,
  type DraftMeta,
  type TreeNode,
  type VaultFile,
} from "../api.ts";

export function VaultBrowser() {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set([""]));
  const [activePath, setActivePath] = useState<string | null>(null);
  const [file, setFile] = useState<VaultFile | null>(null);
  const [drafts, setDrafts] = useState<DraftMeta[]>([]);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftNote, setDraftNote] = useState("");
  const [draftViewing, setDraftViewing] = useState<{
    meta: DraftMeta;
    content: string;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.vaultTree().then(setTree).catch((e: Error) => setErr(e.message));
  }, []);

  useEffect(() => {
    if (!activePath) {
      setFile(null);
      setDrafts([]);
      setDraftViewing(null);
      return;
    }
    api.vaultFile(activePath).then(setFile).catch((e: Error) => setErr(e.message));
    api
      .draftsList(activePath)
      .then((r) => setDrafts(r.drafts))
      .catch(() => {});
    setDraftViewing(null);
  }, [activePath]);

  const toggleDir = (path: string) => {
    setOpenDirs((cur) => {
      const next = new Set(cur);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const snapshot = async () => {
    if (!activePath) return;
    setDraftBusy(true);
    try {
      await api.draftCreate(activePath, draftNote.trim() || undefined);
      setDraftNote("");
      const r = await api.draftsList(activePath);
      setDrafts(r.drafts);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setDraftBusy(false);
    }
  };

  const viewDraft = async (id: number) => {
    const d = await api.draftGet(id);
    setDraftViewing({ meta: d, content: d.content });
  };

  const deleteDraft = async (id: number) => {
    if (!confirm("Delete this snapshot? Cannot be undone.")) return;
    await api.draftDelete(id);
    if (activePath) {
      const r = await api.draftsList(activePath);
      setDrafts(r.drafts);
    }
    if (draftViewing?.meta.id === id) setDraftViewing(null);
  };

  const followWiki = async (target: string) => {
    try {
      const r = await api.vaultResolve(target);
      if (r.path) setActivePath(r.path);
      else setErr(`No file matched [[${target}]]`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="grid grid-cols-[300px,1fr] gap-4 h-full max-w-[1500px] mx-auto">
      <aside className="card overflow-auto">
        <h3 className="font-display text-lg mb-2">Vault</h3>
        {!tree && <p className="text-muted text-sm">Loading…</p>}
        {tree && (
          <div className="text-sm">
            <TreeView
              node={tree}
              activePath={activePath}
              openDirs={openDirs}
              onToggle={toggleDir}
              onPick={setActivePath}
              isRoot
            />
          </div>
        )}
      </aside>

      <section className="card overflow-auto space-y-3">
        {err && <div className="bg-red-900/40 text-red-200 text-sm p-3 rounded">{err}</div>}
        {!activePath && (
          <p className="text-muted text-sm">Pick a file from the tree.</p>
        )}
        {file && (
          <>
            <div className="flex flex-wrap items-baseline gap-2">
              <h2 className="font-display text-2xl">{file.path}</h2>
              <span className="text-xs text-muted">
                {(file.bytes / 1024).toFixed(1)} KB · last modified{" "}
                {new Date(file.mtime).toLocaleString()}
              </span>
            </div>
            {file.frontmatter && (
              <details className="text-xs">
                <summary className="cursor-pointer text-tealBright">Frontmatter</summary>
                <pre className="mt-2 font-mono">{JSON.stringify(file.frontmatter, null, 2)}</pre>
              </details>
            )}
            <FileContent content={file.content} onWikiClick={followWiki} />

            <div className="border-t border-muted/20 pt-3 space-y-2">
              <h3 className="font-display text-lg">Snapshots</h3>
              <div className="flex gap-2 items-center">
                <input
                  className="input flex-1"
                  placeholder="Optional note for this snapshot"
                  value={draftNote}
                  onChange={(e) => setDraftNote(e.target.value)}
                  disabled={draftBusy}
                />
                <button
                  className="btn btn-primary"
                  onClick={snapshot}
                  disabled={draftBusy}
                >
                  {draftBusy ? "Saving…" : "Snapshot now"}
                </button>
              </div>
              {drafts.length === 0 && (
                <p className="text-xs text-muted">No snapshots for this file.</p>
              )}
              <ul className="space-y-1">
                {drafts.map((d) => (
                  <li
                    key={d.id}
                    className="flex items-center gap-2 text-xs font-mono p-1.5 border border-muted/20 rounded"
                  >
                    <span className="text-tealBright">
                      {new Date(d.created_at).toLocaleString()}
                    </span>
                    <span className="text-muted">{(d.bytes / 1024).toFixed(1)} KB</span>
                    {d.note && <span className="italic text-paper">"{d.note}"</span>}
                    <button
                      onClick={() => viewDraft(d.id)}
                      className="btn btn-ghost text-xs ml-auto"
                    >
                      view
                    </button>
                    <button
                      onClick={() => deleteDraft(d.id)}
                      className="btn btn-ghost text-xs"
                    >
                      delete
                    </button>
                  </li>
                ))}
              </ul>
              {draftViewing && (
                <div className="card bg-bg/60 max-h-96 overflow-auto">
                  <div className="text-xs text-tealBright mb-1">
                    Snapshot {new Date(draftViewing.meta.created_at).toLocaleString()}
                  </div>
                  <pre className="whitespace-pre-wrap text-sm font-ui">
                    {draftViewing.content}
                  </pre>
                </div>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function TreeView(props: {
  node: TreeNode;
  activePath: string | null;
  openDirs: Set<string>;
  onToggle: (p: string) => void;
  onPick: (p: string) => void;
  isRoot?: boolean;
}) {
  const { node } = props;
  if (node.kind === "file") {
    const active = props.activePath === node.path;
    return (
      <button
        onClick={() => props.onPick(node.path)}
        className={`w-full text-left px-1.5 py-0.5 rounded truncate ${
          active ? "bg-teal/40 text-paper" : "hover:bg-muted/10 text-paper"
        }`}
      >
        📄 {node.name}
      </button>
    );
  }
  const open = props.openDirs.has(node.path);
  return (
    <div>
      {!props.isRoot && (
        <button
          onClick={() => props.onToggle(node.path)}
          className="w-full text-left px-1.5 py-0.5 rounded hover:bg-muted/10 text-paper truncate"
        >
          {open ? "📂" : "📁"} {node.name}
        </button>
      )}
      {(open || props.isRoot) && node.children && (
        <ul className={`${props.isRoot ? "" : "ml-3 border-l border-muted/20 pl-2"} space-y-0.5`}>
          {node.children.map((c) => (
            <li key={c.path}>
              <TreeView {...props} node={c} isRoot={false} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FileContent({
  content,
  onWikiClick,
}: {
  content: string;
  onWikiClick: (target: string) => void;
}) {
  // Render as <pre> with wikilinks turned into clickable spans. Strips frontmatter.
  const stripped = useMemo(() => {
    const m = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
    return m ? content.slice(m[0].length) : content;
  }, [content]);

  const parts = useMemo(() => {
    const out: { kind: "text" | "wiki"; value: string }[] = [];
    const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      if (m.index > last) out.push({ kind: "text", value: stripped.slice(last, m.index) });
      out.push({ kind: "wiki", value: m[1]!.trim() });
      last = re.lastIndex;
    }
    if (last < stripped.length) out.push({ kind: "text", value: stripped.slice(last) });
    return out;
  }, [stripped]);

  return (
    <pre className="whitespace-pre-wrap font-ui text-sm leading-relaxed">
      {parts.map((p, i) =>
        p.kind === "text" ? (
          <span key={i}>{p.value}</span>
        ) : (
          <button
            key={i}
            onClick={() => onWikiClick(p.value)}
            className="inline px-1 rounded text-tealBright hover:bg-tealBright/20"
          >
            [[{p.value}]]
          </button>
        )
      )}
    </pre>
  );
}
