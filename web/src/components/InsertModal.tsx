// Modal: insert chat-drafted prose into a vault manuscript file.
// Auto-snapshots existing content before write (server-side).

import { useEffect, useMemo, useState } from "react";
import { api, type TreeNode } from "../api.ts";
import { useRecentFiles } from "../recents.ts";
import { DiffView } from "./DiffView.tsx";

type Mode = "append" | "prepend" | "at-line";

type Props = {
  text: string;
  defaultPath?: string;
  onClose: () => void;
  onInserted: (path: string) => void;
};

const WRITABLE_PREFIXES = ["Books/", "Story Ideas/", "Uncensored/"];

function flattenMd(node: TreeNode, out: string[] = []): string[] {
  if (node.kind === "file") {
    if (/\.(md|markdown)$/i.test(node.name)) out.push(node.path);
  } else if (node.children) {
    for (const c of node.children) flattenMd(c, out);
  }
  return out;
}

export function InsertModal({ text, defaultPath, onClose, onInserted }: Props) {
  const [path, setPath] = useState(defaultPath ?? "Books/");
  const [mode, setMode] = useState<Mode>("append");
  const [line, setLine] = useState<number>(1);
  const [note, setNote] = useState("");
  const [allFiles, setAllFiles] = useState<string[]>([]);
  const [existing, setExisting] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { recents, record } = useRecentFiles();

  useEffect(() => {
    api
      .vaultTree()
      .then((t) => setAllFiles(flattenMd(t).filter((p) => WRITABLE_PREFIXES.some((pr) => p.startsWith(pr)))))
      .catch(() => setAllFiles([]));
  }, []);

  // Fetch existing file content when path changes (debounced via simple effect).
  useEffect(() => {
    if (!path || path.endsWith("/")) {
      setExisting(null);
      return;
    }
    let canceled = false;
    setLoadingFile(true);
    api
      .vaultFile(path)
      .then((f) => {
        if (!canceled) setExisting(f.content);
      })
      .catch(() => {
        if (!canceled) setExisting(null);
      })
      .finally(() => {
        if (!canceled) setLoadingFile(false);
      });
    return () => {
      canceled = true;
    };
  }, [path]);

  const writableRecents = useMemo(
    () =>
      recents.filter(
        (p) =>
          WRITABLE_PREFIXES.some((pr) => p.startsWith(pr)) &&
          /\.(md|markdown)$/i.test(p)
      ),
    [recents]
  );

  const suggestions = useMemo(() => {
    const q = path.trim().toLowerCase();
    if (!q || q.endsWith("/")) {
      return allFiles.filter((p) => p.toLowerCase().startsWith(q)).slice(0, 8);
    }
    return allFiles
      .filter((p) => p.toLowerCase().includes(q) && p.toLowerCase() !== q)
      .slice(0, 8);
  }, [allFiles, path]);

  const lineCount = useMemo(() => {
    if (existing == null) return 0;
    if (existing.length === 0) return 0;
    return existing.split("\n").length;
  }, [existing]);

  const maxLine = lineCount + 1;

  // Build preview content
  const previewContent = useMemo(() => {
    const base = existing ?? "";
    if (mode === "append") {
      const sep = base.length === 0 || base.endsWith("\n") ? "" : "\n";
      const trail = text.endsWith("\n") ? "" : "\n";
      return base + sep + text + trail;
    }
    if (mode === "prepend") {
      return base.length === 0 ? (text.endsWith("\n") ? text : text + "\n") : text + "\n\n" + base;
    }
    const lines = base.length === 0 ? [] : base.split("\n");
    const target = Math.min(Math.max(1, line), lines.length + 1);
    const insertText = text.endsWith("\n") ? text : text + "\n";
    const insertLines = insertText.split("\n");
    if (insertLines.length > 0 && insertLines[insertLines.length - 1] === "") insertLines.pop();
    const before = lines.slice(0, target - 1);
    const after = lines.slice(target - 1);
    return [...before, ...insertLines, ...after].join("\n");
  }, [existing, text, mode, line]);

  const lineOutOfBounds =
    mode === "at-line" && (line < 1 || line > maxLine);
  const pathLooksValid =
    WRITABLE_PREFIXES.some((p) => path.startsWith(p)) &&
    /\.(md|markdown|txt)$/i.test(path);

  const submit = async () => {
    if (busy) return;
    setErr(null);
    if (!pathLooksValid) {
      setErr("Path must be under Books/, Story Ideas/, or Uncensored/ and end with .md/.markdown/.txt");
      return;
    }
    if (lineOutOfBounds) {
      setErr(`Line ${line} out of bounds (1..${maxLine})`);
      return;
    }
    setBusy(true);
    try {
      await api.vaultInsert(path, text, mode, mode === "at-line" ? line : undefined, note || undefined);
      record(path);
      onInserted(path);
      onClose();
    } catch (e) {
      setErr((e as Error).message || "insert failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="card max-w-3xl w-full max-h-[90vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-display">Insert into file</h2>
          <button onClick={onClose} className="btn btn-ghost text-xs">
            Close
          </button>
        </div>

        {err && (
          <div className="bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200 text-sm p-2 rounded mb-3">
            {err}
          </div>
        )}

        <label className="block text-xs text-muted mb-1">Target file</label>
        <input
          className="input w-full font-mono text-sm"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="Books/<series>/<book>/Chapter-01.md"
          list="quill-insert-paths"
          autoFocus
        />
        <datalist id="quill-insert-paths">
          {suggestions.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>

        {writableRecents.length > 0 && (
          <div className="mt-1 text-xs text-muted">
            Recent:{" "}
            {writableRecents.slice(0, 5).map((p, i) => (
              <span key={p}>
                {i > 0 && " · "}
                <button
                  onClick={() => setPath(p)}
                  className="text-tealBright hover:underline font-mono"
                >
                  {p}
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="insert-mode"
              checked={mode === "append"}
              onChange={() => setMode("append")}
            />
            Append
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="insert-mode"
              checked={mode === "prepend"}
              onChange={() => setMode("prepend")}
            />
            Prepend
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="insert-mode"
              checked={mode === "at-line"}
              onChange={() => setMode("at-line")}
            />
            At line
          </label>
          {mode === "at-line" && (
            <span className="flex items-center gap-2">
              <input
                type="number"
                className="input w-24 text-sm"
                min={1}
                max={maxLine || 1}
                value={line}
                onChange={(e) => setLine(Math.max(1, Number(e.target.value) || 1))}
              />
              <span className="text-muted text-xs">
                {existing != null
                  ? `valid 1..${maxLine} (${maxLine} = end)`
                  : "(file does not exist yet)"}
              </span>
            </span>
          )}
        </div>

        <label className="block text-xs text-muted mt-3 mb-1">
          Snapshot note (optional)
        </label>
        <input
          className="input w-full text-sm"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="auto: before insert"
        />

        <div className="mt-4">
          <div className="text-xs text-muted mb-1">
            Preview {loadingFile && <span>(loading…)</span>}
            {existing == null && !loadingFile && <span> (new file)</span>}
          </div>
          <DiffView
            left={{ label: existing == null ? "(new file)" : path, content: existing ?? "" }}
            right={{ label: "after insert", content: previewContent }}
          />
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="btn btn-ghost">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || !pathLooksValid || lineOutOfBounds}
            className="btn btn-primary"
          >
            {busy ? "Inserting…" : "Insert (auto-snapshot first)"}
          </button>
        </div>
      </div>
    </div>
  );
}
