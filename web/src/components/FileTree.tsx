// Vault file tree + recent files + "open folder as workspace". Controlled:
// the parent owns the active path and is notified via onPick. Extracted from
// VaultBrowser so the tree can live in the IDE shell's left panel / mobile
// Files pane independently of the editor.

import { useEffect, useState } from "react";
import { api, type TreeNode } from "../api.ts";
import { RecentFiles } from "./RecentFiles.tsx";
import { useRecentWorkspaces } from "../recents.ts";

export function FileTree({
  activePath,
  onPick,
  onOpenWorkspace,
}: {
  activePath: string | null;
  onPick: (path: string) => void;
  onOpenWorkspace?: (path: string) => void;
}) {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set([""]));
  const [err, setErr] = useState<string | null>(null);
  const ws = useRecentWorkspaces();

  useEffect(() => {
    api.vaultTree().then(setTree).catch((e: Error) => setErr(e.message));
  }, []);

  const toggleDir = (path: string) => {
    setOpenDirs((cur) => {
      const next = new Set(cur);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="h-full overflow-auto">
      {onOpenWorkspace && ws.recents.length > 0 && (
        <div className="card space-y-1 mb-3 p-2">
          <div className="text-[11px] text-muted uppercase tracking-wide flex items-center">
            Workspaces
            <button
              onClick={ws.clear}
              className="ml-auto text-muted hover:text-tealBright normal-case"
            >
              clear
            </button>
          </div>
          {ws.recents.map((w) => (
            <button
              key={w.path}
              onClick={() => onOpenWorkspace(w.path)}
              title={w.path}
              className="w-full text-left truncate text-tealBright hover:underline"
            >
              📂 {w.name}
            </button>
          ))}
        </div>
      )}
      <RecentFiles onPick={onPick} />
      <h3 className="font-display text-lg mb-1">Vault</h3>
      {onOpenWorkspace && (
        <p className="text-[11px] text-muted mb-2">
          Hover a folder → <span className="text-tealBright">open ▸</span> to
          chat in it
        </p>
      )}
      {err && <p className="text-red-400 text-xs mb-2">{err}</p>}
      {!tree && <p className="text-muted text-sm">Loading…</p>}
      {tree && (
        <div className="text-sm">
          <TreeView
            node={tree}
            activePath={activePath}
            openDirs={openDirs}
            onToggle={toggleDir}
            onPick={onPick}
            onOpenWorkspace={onOpenWorkspace}
            isRoot
          />
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
          active
            ? "bg-teal/40 text-paper"
            : "hover:bg-bg/10 dark:hover:bg-muted/10 text-bg dark:text-paper"
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
        <ul
          className={`${
            props.isRoot ? "" : "ml-3 border-l border-muted/20 pl-2"
          } space-y-0.5`}
        >
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
