// Read-only vault tree + file viewer with frontmatter, wikilink resolution,
// and per-file draft snapshots.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type DraftMeta,
  type TreeNode,
  type VaultFile,
} from "../api.ts";
import { DiffView } from "./DiffView.tsx";
import { MarkdownView } from "./MarkdownView.tsx";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor.tsx";
import { InlineRewriteModal } from "./InlineRewriteModal.tsx";
import { lintSummary } from "../editor/linter.ts";
import { readAloud, stopReading } from "../tts.ts";
import { inlineContinueStream } from "../api.ts";
import { recentFiles } from "../recents.ts";
import { RecentFiles } from "./RecentFiles.tsx";

const WRITABLE_PREFIXES = ["Books/", "Story Ideas/", "Uncensored/"];

function isEditablePath(path: string | null): boolean {
  if (!path) return false;
  if (!/\.(md|markdown)$/i.test(path)) return false;
  return WRITABLE_PREFIXES.some((p) => path.startsWith(p));
}

function useIsDarkTheme(): boolean {
  const [isDark, setIsDark] = useState(() =>
    typeof document !== "undefined"
      ? document.documentElement.classList.contains("dark")
      : false,
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setIsDark(root.classList.contains("dark"));
    });
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

const PENDING_KEY = "quill.vaultPending";

type Comparison =
  | { kind: "single"; meta: DraftMeta; content: string }
  | {
      kind: "diff";
      left: { label: string; content: string };
      right: { label: string; content: string };
    };

export function VaultBrowser({
  onOpenWorkspace,
}: { onOpenWorkspace?: (path: string) => void } = {}) {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set([""]));
  const [activePath, setActivePath] = useState<string | null>(null);
  const [file, setFile] = useState<VaultFile | null>(null);
  const [drafts, setDrafts] = useState<DraftMeta[]>([]);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftNote, setDraftNote] = useState("");
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [selectedDrafts, setSelectedDrafts] = useState<Set<number>>(
    () => new Set(),
  );
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [dirtyContent, setDirtyContent] = useState("");
  const [saving, setSaving] = useState(false);
  const editorRef = useRef<MarkdownEditorHandle | null>(null);
  const [rewrite, setRewrite] = useState<{
    selection: string;
    range: { from: number; to: number };
  } | null>(null);
  const [continuing, setContinuing] = useState(false);
  const [voiceScore, setVoiceScore] = useState<{ score: number; band: string } | null>(null);
  const isDark = useIsDarkTheme();

  useEffect(() => {
    api.vaultTree().then(setTree).catch((e: Error) => setErr(e.message));
    // Consume pending navigate request from citation auto-link
    const consume = () => {
      const p = localStorage.getItem(PENDING_KEY);
      if (p) {
        localStorage.removeItem(PENDING_KEY);
        setActivePath(p);
      }
    };
    consume();
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ path?: string }>).detail;
      if (detail?.path) setActivePath(detail.path);
      else consume();
    };
    window.addEventListener("quill:navigate-vault", handler);
    return () => window.removeEventListener("quill:navigate-vault", handler);
  }, []);

  // Record viewed paths for the recent-files store
  useEffect(() => {
    if (activePath) recentFiles.push({ path: activePath, ts: Date.now() });
  }, [activePath]);

  useEffect(() => {
    if (!activePath) {
      setFile(null);
      setDrafts([]);
      setComparison(null);
      setSelectedDrafts(new Set());
      return;
    }
    api.vaultFile(activePath).then(setFile).catch((e: Error) => setErr(e.message));
    api
      .draftsList(activePath)
      .then((r) => setDrafts(r.drafts))
      .catch(() => {});
    setComparison(null);
    setSelectedDrafts(new Set());
    setEditing(false);
    setDirtyContent("");
  }, [activePath]);

  const isDirty = editing && file !== null && dirtyContent !== file.content;
  const canEdit = isEditablePath(activePath);

  const beginEdit = () => {
    if (!file || !canEdit) return;
    setDirtyContent(file.content);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDirtyContent("");
  };

  const saveEdit = async () => {
    if (!file || !activePath || !editing) return;
    setSaving(true);
    setErr(null);
    try {
      await api.vaultWrite(activePath, dirtyContent, "auto: editor save");
      const fresh = await api.vaultFile(activePath);
      setFile(fresh);
      const r = await api.draftsList(activePath);
      setDrafts(r.drafts);
      // Voice score on save (passive — non-blocking)
      api
        .voiceCheck(dirtyContent.slice(0, 4000))
        .then((v) => setVoiceScore({ score: v.score, band: v.band }))
        .catch(() => {});
      setEditing(false);
      setDirtyContent("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

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
    setComparison({ kind: "single", meta: d, content: d.content });
  };

  const deleteDraft = async (id: number) => {
    if (!confirm("Delete this snapshot? Cannot be undone.")) return;
    await api.draftDelete(id);
    if (activePath) {
      const r = await api.draftsList(activePath);
      setDrafts(r.drafts);
    }
    setSelectedDrafts((cur) => {
      const next = new Set(cur);
      next.delete(id);
      return next;
    });
    if (
      comparison &&
      comparison.kind === "single" &&
      comparison.meta.id === id
    ) {
      setComparison(null);
    }
  };

  const toggleSelect = (id: number) => {
    setSelectedDrafts((cur) => {
      const next = new Set(cur);
      if (next.has(id)) {
        next.delete(id);
      } else {
        if (next.size >= 2) {
          // Drop oldest selection to keep cap at 2.
          const first = next.values().next().value;
          if (first !== undefined) next.delete(first);
        }
        next.add(id);
      }
      return next;
    });
  };

  const draftLabel = (meta: DraftMeta) =>
    `Snapshot ${new Date(meta.created_at).toLocaleString()}`;

  const diffSelected = async () => {
    const ids = Array.from(selectedDrafts);
    if (ids.length !== 2) return;
    const [id0, id1] = ids;
    if (id0 === undefined || id1 === undefined) return;
    try {
      const [a, b] = await Promise.all([
        api.draftGet(id0),
        api.draftGet(id1),
      ]);
      // Older snapshot on the left.
      const [olderMeta, newerMeta] =
        a.created_at <= b.created_at ? [a, b] : [b, a];
      setComparison({
        kind: "diff",
        left: { label: draftLabel(olderMeta), content: olderMeta.content },
        right: { label: draftLabel(newerMeta), content: newerMeta.content },
      });
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const diffVsCurrent = async () => {
    const ids = Array.from(selectedDrafts);
    if (ids.length !== 1 || !file) return;
    const [snapId] = ids;
    if (snapId === undefined) return;
    try {
      const snap = await api.draftGet(snapId);
      setComparison({
        kind: "diff",
        left: { label: draftLabel(snap), content: snap.content },
        right: { label: `Current (${file.path})`, content: file.content },
      });
    } catch (e) {
      setErr((e as Error).message);
    }
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
        <RecentFiles onPick={setActivePath} />
        <h3 className="font-display text-lg mb-1">Vault</h3>
        {onOpenWorkspace && (
          <p className="text-[11px] text-muted mb-2">
            Hover a folder → <span className="text-tealBright">open ▸</span> to chat in it
          </p>
        )}
        {!tree && <p className="text-muted text-sm">Loading…</p>}
        {tree && (
          <div className="text-sm">
            <TreeView
              node={tree}
              activePath={activePath}
              openDirs={openDirs}
              onToggle={toggleDir}
              onPick={setActivePath}
              onOpenWorkspace={onOpenWorkspace}
              isRoot
            />
          </div>
        )}
      </aside>

      <section className="card overflow-auto space-y-3">
        {err && <div className="bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200 text-sm p-3 rounded">{err}</div>}
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
              {isDirty && (
                <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">
                  ● unsaved
                </span>
              )}
              <button
                onClick={() => readAloud(file.content.slice(0, 6000)).catch((e: Error) => setErr(e.message))}
                className="btn btn-ghost text-xs"
                title="Read aloud (browser TTS)"
              >
                ▶ read
              </button>
              <button
                onClick={() => stopReading()}
                className="btn btn-ghost text-xs"
                title="Stop reading"
              >
                ■
              </button>
              <span className="ml-auto flex gap-2">
                {!editing && (
                  <button
                    type="button"
                    className="btn btn-ghost text-xs"
                    onClick={beginEdit}
                    disabled={!canEdit}
                    title={
                      canEdit
                        ? "Edit this file"
                        : "Read-only (only Books/, Story Ideas/, Uncensored/ markdown is editable)"
                    }
                  >
                    Edit
                  </button>
                )}
                {editing && (
                  <>
                    <button
                      type="button"
                      className="btn btn-primary text-xs"
                      onClick={saveEdit}
                      disabled={saving || !isDirty}
                    >
                      {saving ? "Saving…" : "Save (snapshot first)"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost text-xs"
                      onClick={cancelEdit}
                      disabled={saving}
                    >
                      Cancel
                    </button>
                  </>
                )}
              </span>
            </div>
            {file.frontmatter && (
              <details className="text-xs">
                <summary className="cursor-pointer text-tealBright">Frontmatter</summary>
                <pre className="mt-2 font-mono">{JSON.stringify(file.frontmatter, null, 2)}</pre>
              </details>
            )}
            {editing ? (
              <>
                <div className="flex items-center gap-2 text-xs text-muted">
                  <span>⌘K rewrite · Tab continue · ⌘S save</span>
                  {(() => {
                    const s = lintSummary(dirtyContent || file.content);
                    if (s.total === 0) return <span className="text-tealBright ml-auto">✓ no anti-pattern hits</span>;
                    return (
                      <span className="ml-auto">
                        {s.high > 0 && <span className="text-red-500">{s.high} high</span>}
                        {s.medium > 0 && <span className="text-amber-500 ml-2">{s.medium} medium</span>}
                        {s.low > 0 && <span className="text-muted ml-2">{s.low} low</span>}
                      </span>
                    );
                  })()}
                </div>
                <MarkdownEditor
                  ref={editorRef}
                  initialContent={file.content}
                  onChange={setDirtyContent}
                  onSaveShortcut={saveEdit}
                  onCommandK={(selection, range) =>
                    setRewrite({ selection, range })
                  }
                  onTabContinue={async (preceding, cursorPos) => {
                    if (continuing) return;
                    setContinuing(true);
                    try {
                      const storyIdRaw = localStorage.getItem("quill.activeStoryId");
                      const storyId = storyIdRaw ? Number(storyIdRaw) : undefined;
                      let buf = "";
                      let writePos = cursorPos;
                      for await (const ev of inlineContinueStream(preceding, storyId, "paragraph")) {
                        if (ev.event === "delta") {
                          const data = ev.data as { text: string };
                          buf += data.text;
                          // Insert delta at the moving cursor
                          editorRef.current?.insertAt(writePos, data.text);
                          writePos += data.text.length;
                        } else if (ev.event === "error") {
                          setErr((ev.data as { error: string }).error);
                          break;
                        }
                      }
                    } finally {
                      setContinuing(false);
                    }
                  }}
                  theme={isDark ? "dark" : "light"}
                />
              </>
            ) : (
              <FileContent content={file.content} onWikiClick={followWiki} />
            )}

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
              {drafts.length > 0 && (
                <div className="flex flex-wrap gap-2 items-center text-xs">
                  <span className="text-muted">
                    {selectedDrafts.size === 0
                      ? "Tick up to 2 snapshots to compare."
                      : `${selectedDrafts.size} selected`}
                  </span>
                  <button
                    className="btn btn-ghost text-xs"
                    onClick={diffSelected}
                    disabled={selectedDrafts.size !== 2}
                  >
                    Diff selected
                  </button>
                  <button
                    className="btn btn-ghost text-xs"
                    onClick={diffVsCurrent}
                    disabled={selectedDrafts.size !== 1 || !file}
                  >
                    Diff vs current
                  </button>
                  {selectedDrafts.size > 0 && (
                    <button
                      className="btn btn-ghost text-xs"
                      onClick={() => setSelectedDrafts(new Set())}
                    >
                      Clear selection
                    </button>
                  )}
                </div>
              )}
              <ul className="space-y-1">
                {drafts.map((d) => {
                  const isChecked = selectedDrafts.has(d.id);
                  return (
                    <li
                      key={d.id}
                      className="flex items-center gap-2 text-xs font-mono p-1.5 border border-muted/20 rounded"
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleSelect(d.id)}
                        aria-label={`Select snapshot from ${new Date(d.created_at).toLocaleString()} for diff`}
                        className="cursor-pointer"
                      />
                      <span className="text-tealBright">
                        {new Date(d.created_at).toLocaleString()}
                      </span>
                      <span className="text-muted">
                        {(d.bytes / 1024).toFixed(1)} KB
                      </span>
                      {d.note && (
                        <span className="italic text-bg dark:text-paper">
                          "{d.note}"
                        </span>
                      )}
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
                  );
                })}
              </ul>
              {comparison && comparison.kind === "single" && (
                <div className="card bg-paper/60 dark:bg-bg/60 max-h-96 overflow-auto">
                  <div className="flex items-baseline gap-2 mb-1">
                    <div className="text-xs text-tealBright">
                      Snapshot{" "}
                      {new Date(comparison.meta.created_at).toLocaleString()}
                    </div>
                    <button
                      className="btn btn-ghost text-xs ml-auto"
                      onClick={() => setComparison(null)}
                    >
                      close
                    </button>
                  </div>
                  <pre className="whitespace-pre-wrap text-sm font-ui">
                    {comparison.content}
                  </pre>
                </div>
              )}
              {comparison && comparison.kind === "diff" && (
                <div className="space-y-1">
                  <div className="flex">
                    <button
                      className="btn btn-ghost text-xs ml-auto"
                      onClick={() => setComparison(null)}
                    >
                      close diff
                    </button>
                  </div>
                  <DiffView left={comparison.left} right={comparison.right} />
                </div>
              )}
            </div>
          </>
        )}
      </section>
      {rewrite && (
        <InlineRewriteModal
          selection={rewrite.selection}
          storyId={(() => {
            const v = localStorage.getItem("quill.activeStoryId");
            return v ? Number(v) : null;
          })()}
          onAccept={(replacement) => {
            editorRef.current?.replaceRange(rewrite.range.from, rewrite.range.to, replacement);
            setRewrite(null);
          }}
          onCancel={() => setRewrite(null)}
        />
      )}
      {voiceScore && (
        <div className="fixed bottom-4 right-4 z-40 px-3 py-2 rounded-full text-xs font-mono bg-bg/90 dark:bg-paper/90 text-paper dark:text-bg border border-tealBright/40 shadow-lg">
          voice: {voiceScore.score.toFixed(2)} ({voiceScore.band})
          <button
            onClick={() => setVoiceScore(null)}
            className="ml-2 text-muted hover:text-tealBright"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

function TreeView(props: {
  node: TreeNode;
  activePath: string | null;
  openDirs: Set<string>;
  onToggle: (p: string) => void;
  onPick: (p: string) => void;
  onOpenWorkspace?: (p: string) => void;
  isRoot?: boolean;
}) {
  const { node } = props;
  if (node.kind === "file") {
    const active = props.activePath === node.path;
    return (
      <button
        onClick={() => props.onPick(node.path)}
        className={`w-full text-left px-1.5 py-0.5 rounded truncate ${
          active ? "bg-teal/40 text-paper" : "hover:bg-bg/10 dark:hover:bg-muted/10 text-bg dark:text-paper"
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
        <div className="flex items-center group">
          <button
            onClick={() => props.onToggle(node.path)}
            className="flex-1 min-w-0 text-left px-1.5 py-0.5 rounded hover:bg-bg/10 dark:hover:bg-muted/10 text-bg dark:text-paper truncate"
          >
            {open ? "📂" : "📁"} {node.name}
          </button>
          {props.onOpenWorkspace && (
            <button
              onClick={() => props.onOpenWorkspace!(node.path)}
              title={`Open "${node.name}" as a chat workspace`}
              className="opacity-0 group-hover:opacity-100 focus:opacity-100 btn btn-ghost text-xs px-1.5 py-0.5 shrink-0"
            >
              open ▸
            </button>
          )}
        </div>
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
  // Strip YAML frontmatter, then hand off to MarkdownView for rendering.
  const stripped = useMemo(() => {
    const m = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
    return m ? content.slice(m[0].length) : content;
  }, [content]);

  return <MarkdownView content={stripped} onWikiClick={onWikiClick} />;
}
