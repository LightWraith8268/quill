// Command palette (Ctrl/Cmd+P): fuzzy-jump to any file, recent workspace, or
// view, plus a few quick actions. Keyboard-driven; closes on pick or Escape.

import { useEffect, useMemo, useRef, useState } from "react";
import { api, type TreeNode } from "../api.ts";

export type PaletteCommand = {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
};

type Item = { key: string; label: string; hint?: string; run: () => void };

function flattenFiles(node: TreeNode, out: { path: string; name: string }[]) {
  if (node.kind === "file") out.push({ path: node.path, name: node.name });
  else node.children?.forEach((c) => flattenFiles(c, out));
}

export function CommandPalette({
  open,
  onClose,
  commands,
  onOpenFile,
  onOpenWorkspace,
  recents,
}: {
  open: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
  onOpenFile: (path: string) => void;
  onOpenWorkspace: (path: string) => void;
  recents: { path: string; name: string }[];
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [files, setFiles] = useState<{ path: string; name: string }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setSel(0);
    inputRef.current?.focus();
    api
      .vaultTree()
      .then((t) => {
        const out: { path: string; name: string }[] = [];
        flattenFiles(t, out);
        setFiles(out);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const items: Item[] = useMemo(() => {
    const list: Item[] = [];
    for (const c of commands)
      list.push({ key: `cmd:${c.id}`, label: c.label, hint: c.hint ?? "view", run: c.run });
    for (const w of recents)
      list.push({
        key: `ws:${w.path}`,
        label: w.name,
        hint: `workspace · ${w.path}`,
        run: () => onOpenWorkspace(w.path),
      });
    for (const f of files)
      list.push({
        key: `file:${f.path}`,
        label: f.name,
        hint: f.path,
        run: () => onOpenFile(f.path),
      });
    return list;
  }, [commands, recents, files, onOpenFile, onOpenWorkspace]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items.slice(0, 50);
    return items
      .filter(
        (i) =>
          i.label.toLowerCase().includes(s) ||
          (i.hint ?? "").toLowerCase().includes(s)
      )
      .slice(0, 50);
  }, [items, q]);

  useEffect(() => {
    setSel(0);
  }, [q]);

  if (!open) return null;

  const activate = (i: Item | undefined) => {
    if (!i) return;
    onClose();
    i.run();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl mx-3 card p-0 overflow-hidden shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="w-full bg-transparent px-4 py-3 text-sm outline-none border-b border-muted/20 text-bg dark:text-paper"
          placeholder="Go to file, workspace, or view…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              activate(filtered[sel]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <ul className="max-h-80 overflow-auto py-1">
          {filtered.length === 0 && (
            <li className="px-4 py-2 text-sm text-muted">No matches.</li>
          )}
          {filtered.map((i, idx) => (
            <li key={i.key}>
              <button
                onMouseEnter={() => setSel(idx)}
                onClick={() => activate(i)}
                className={`w-full text-left px-4 py-2 flex items-center gap-2 text-sm ${
                  idx === sel
                    ? "bg-teal/30"
                    : "hover:bg-bg/10 dark:hover:bg-muted/10"
                }`}
              >
                <span className="truncate">{i.label}</span>
                {i.hint && (
                  <span className="ml-auto text-[11px] text-muted truncate max-w-[55%]">
                    {i.hint}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
