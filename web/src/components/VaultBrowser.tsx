// Vault tab: file tree + editor side by side. Now a thin composition of the
// extracted FileTree + FileEditor (which the IDE shell also uses). Owns the
// active path and the chat-citation → open-file bridge.

import { useEffect, useState } from "react";
import { FileTree } from "./FileTree.tsx";
import { FileEditor } from "./FileEditor.tsx";
import { VAULT_NAV_EVENT, VAULT_PENDING_KEY } from "../citations.ts";

const ACTIVE_STORY_KEY = "quill.activeStoryId";

function loadActiveStoryId(): number | null {
  const v = localStorage.getItem(ACTIVE_STORY_KEY);
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function VaultBrowser({
  onOpenWorkspace,
}: { onOpenWorkspace?: (path: string) => void } = {}) {
  const [activePath, setActivePath] = useState<string | null>(null);

  useEffect(() => {
    // Consume a pending navigate request stashed by a chat citation click.
    const consume = () => {
      const p = localStorage.getItem(VAULT_PENDING_KEY);
      if (p) {
        localStorage.removeItem(VAULT_PENDING_KEY);
        setActivePath(p);
      }
    };
    consume();
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ path?: string }>).detail;
      if (detail?.path) setActivePath(detail.path);
      else consume();
    };
    window.addEventListener(VAULT_NAV_EVENT, handler);
    return () => window.removeEventListener(VAULT_NAV_EVENT, handler);
  }, []);

  return (
    <div className="grid grid-cols-[300px,1fr] gap-4 h-full max-w-[1500px] mx-auto">
      <aside className="card overflow-auto">
        <FileTree
          activePath={activePath}
          onPick={setActivePath}
          onOpenWorkspace={onOpenWorkspace}
        />
      </aside>
      <FileEditor
        path={activePath}
        activeStoryId={loadActiveStoryId()}
        onOpenPath={setActivePath}
      />
    </div>
  );
}
