// The writing IDE shell. File tree + editor + Claude chat in one responsive
// layout — a code-server for prose, with the canon RAG wired into chat.
//
//   Desktop (>= lg): activity bar | tree | editor/view | chat
//     - tree + chat panes are collapsible and drag-resizable (mouse + keyboard)
//     - the 7 auxiliary views (Search, Lore, Characters, Outline, Workflows,
//       Styles, Stats) open in the center, layered over the editor
//   Mobile (< lg): one pane + a bottom tab bar — Files / Editor / Chat / More
//     - Files = tree (tap a file -> Editor); More = the 7 aux views
//     - this is the thing code-server can't do: thumb-usable on a phone
//
// One stable element tree: every pane is always mounted and shown/hidden via
// `hidden` (display:none), so crossing the breakpoint or flipping panes never
// remounts the editor/tree/chat and never drops an in-progress edit, the
// tree's expanded state, or an in-flight chat stream.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { VAULT_NAV_EVENT, VAULT_PENDING_KEY } from "../citations.ts";
import { FileTree } from "./FileTree.tsx";
import { FileEditor } from "./FileEditor.tsx";
import { ChatPanel } from "./ChatPanel.tsx";
import { SearchPanel } from "./SearchPanel.tsx";
import { LoreBrowser } from "./LoreBrowser.tsx";
import { CanonBrowser } from "./CanonBrowser.tsx";
import { SnapshotBrowser } from "./SnapshotBrowser.tsx";
import { CharacterTimeline } from "./CharacterTimeline.tsx";
import { OutlineView } from "./OutlineView.tsx";
import { StructureBrowser } from "./StructureBrowser.tsx";
import { StyleBrowser } from "./StyleBrowser.tsx";
import { StatsPanel } from "./StatsPanel.tsx";
import { WorkflowRunner } from "./WorkflowRunner.tsx";

type CenterView =
  | "editor"
  | "search"
  | "lore"
  | "canon"
  | "history"
  | "characters"
  | "outline"
  | "structure"
  | "workflows"
  | "styles"
  | "stats";
type AuxView = Exclude<CenterView, "editor">;
type MobilePane = "files" | "editor" | "chat" | "more";

const LEFT_W_KEY = "quill.ide.leftWidth";
const CHAT_W_KEY = "quill.ide.chatWidth";
const TREE_OPEN_KEY = "quill.ide.treeOpen";
const CHAT_OPEN_KEY = "quill.ide.chatOpen";

const LEFT_MIN = 180;
const LEFT_MAX = 560;
const CHAT_MIN = 300;
const CHAT_MAX = 760;

const VIEW_META: Record<CenterView, { title: string; icon: string; needsStory?: boolean }> = {
  editor: { title: "Editor", icon: "📝" },
  search: { title: "Search", icon: "🔍" },
  lore: { title: "Lore", icon: "📖" },
  canon: { title: "Canon", icon: "📜", needsStory: true },
  history: { title: "History", icon: "🕘", needsStory: true },
  characters: { title: "Characters", icon: "👤" },
  outline: { title: "Outline", icon: "🗺", needsStory: true },
  structure: { title: "Structure", icon: "📐", needsStory: true },
  workflows: { title: "Workflows", icon: "⚙", needsStory: true },
  styles: { title: "Styles", icon: "✒" },
  stats: { title: "Stats", icon: "📊" },
};

const AUX_ORDER: AuxView[] = [
  "search",
  "lore",
  "canon",
  "history",
  "characters",
  "outline",
  "structure",
  "workflows",
  "styles",
  "stats",
];

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(query);
    const handler = () => setMatches(mq.matches);
    handler();
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [query]);
  return matches;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function numFrom(key: string, fallback: number): number {
  const v = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
function boolFrom(key: string, fallback: boolean): boolean {
  const v = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  return v === null ? fallback : v === "1";
}

export function IdeShell({
  activeStoryId,
  setActiveStoryId,
  onError,
}: {
  activeStoryId: number | null;
  setActiveStoryId: (id: number) => void;
  onError?: (msg: string) => void;
}) {
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [centerView, setCenterView] = useState<CenterView>("editor");
  const [mobilePane, setMobilePane] = useState<MobilePane>(
    activeStoryId ? "chat" : "files",
  );
  const [treeOpen, setTreeOpen] = useState(() => boolFrom(TREE_OPEN_KEY, true));
  const [chatOpen, setChatOpen] = useState(() => boolFrom(CHAT_OPEN_KEY, true));
  const [leftWidth, setLeftWidth] = useState(() => numFrom(LEFT_W_KEY, 280));
  const [chatWidth, setChatWidth] = useState(() => numFrom(CHAT_W_KEY, 420));

  // Whether the editor has unsaved changes — used to guard navigation away.
  const dirtyRef = useRef(false);

  useEffect(() => {
    localStorage.setItem(TREE_OPEN_KEY, treeOpen ? "1" : "0");
  }, [treeOpen]);
  useEffect(() => {
    localStorage.setItem(CHAT_OPEN_KEY, chatOpen ? "1" : "0");
  }, [chatOpen]);
  useEffect(() => {
    localStorage.setItem(LEFT_W_KEY, String(Math.round(leftWidth)));
  }, [leftWidth]);
  useEffect(() => {
    localStorage.setItem(CHAT_W_KEY, String(Math.round(chatWidth)));
  }, [chatWidth]);

  const openPathRef = useRef(openPath);
  openPathRef.current = openPath;

  const openFile = (p: string) => {
    if (
      p !== openPathRef.current &&
      dirtyRef.current &&
      !window.confirm("Discard unsaved changes to the current file?")
    ) {
      return;
    }
    setOpenPath(p);
    setCenterView("editor");
    setMobilePane("editor");
  };
  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;

  // Chat citation click -> open the cited file in the editor and focus it.
  // Always clear the pending key (event path included) so a stale path can't
  // be force-opened on a later mount / PWA relaunch.
  useEffect(() => {
    const consume = () => {
      const p = localStorage.getItem(VAULT_PENDING_KEY);
      if (p) {
        localStorage.removeItem(VAULT_PENDING_KEY);
        openFileRef.current(p);
      }
    };
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ path?: string }>).detail;
      if (detail?.path) {
        localStorage.removeItem(VAULT_PENDING_KEY);
        openFileRef.current(detail.path);
      } else {
        consume();
      }
    };
    window.addEventListener(VAULT_NAV_EVENT, handler);
    consume();
    return () => window.removeEventListener(VAULT_NAV_EVENT, handler);
  }, []);

  // When the active story changes (e.g. picked from the top-bar dropdown),
  // surface its chat — mirroring the open-workspace path so both routes behave
  // the same. Skips the initial mount (handled by the mobilePane initializer).
  const prevStoryRef = useRef(activeStoryId);
  useEffect(() => {
    if (prevStoryRef.current !== activeStoryId) {
      prevStoryRef.current = activeStoryId;
      if (activeStoryId !== null) {
        setChatOpen(true);
        setMobilePane("chat");
      }
    }
  }, [activeStoryId]);

  const openWorkspace = (path: string) => {
    api
      .openWorkspace(path)
      .then((r) => {
        setActiveStoryId(r.story.id);
        setChatOpen(true);
        setMobilePane("chat");
        // Reflect the folder in the URL so it's bookmarkable / lockable
        // (code-server style: ?folder=/abs/path).
        try {
          window.history.replaceState(
            null,
            "",
            `?folder=${encodeURIComponent(r.folder)}`
          );
        } catch {
          /* ignore */
        }
      })
      .catch((e: Error) => onError?.(e.message));
  };

  const goAux = (v: AuxView) => {
    setCenterView(v);
    setMobilePane("editor");
  };

  const treeShown = isDesktop ? treeOpen : mobilePane === "files";
  const chatShown = isDesktop ? chatOpen : mobilePane === "chat";
  const centerShown = isDesktop ? true : mobilePane === "editor";
  const moreShown = !isDesktop && mobilePane === "more";

  const editorTabActive = mobilePane === "editor" && centerView === "editor";
  const moreTabActive =
    mobilePane === "more" || (mobilePane === "editor" && centerView !== "editor");

  return (
    <div className={cx("h-full min-h-0 flex", isDesktop ? "flex-row" : "flex-col")}>
      {/* Activity bar (desktop only) */}
      <nav
        aria-label="Views"
        className={cx(
          "shrink-0 w-12 flex-col items-center py-2 gap-1 border-r border-bg/10 dark:border-muted/20 overflow-y-auto",
          isDesktop ? "flex" : "hidden",
        )}
      >
        <ActivityButton
          title="Editor"
          nav
          active={centerView === "editor"}
          onClick={() => setCenterView("editor")}
        >
          📝
        </ActivityButton>
        <ActivityButton
          title={treeOpen ? "Hide files" : "Show files"}
          active={treeOpen}
          onClick={() => setTreeOpen((v) => !v)}
        >
          🗂
        </ActivityButton>
        <div className="w-6 my-1 border-t border-bg/10 dark:border-muted/20" />
        {AUX_ORDER.map((v) => (
          <ActivityButton
            key={v}
            title={VIEW_META[v].title}
            nav
            active={centerView === v}
            onClick={() => setCenterView(v)}
          >
            {VIEW_META[v].icon}
          </ActivityButton>
        ))}
        <div className="mt-auto" />
        <ActivityButton
          title={chatOpen ? "Hide chat" : "Show chat"}
          active={chatOpen}
          onClick={() => setChatOpen((v) => !v)}
        >
          💬
        </ActivityButton>
      </nav>

      {/* File tree */}
      <aside
        className={cx(
          "min-h-0 overflow-hidden",
          !treeShown && "hidden",
          treeShown &&
            (isDesktop
              ? "shrink-0 border-r border-bg/10 dark:border-muted/20"
              : "flex-1 p-2"),
        )}
        style={isDesktop && treeShown ? { width: leftWidth } : undefined}
      >
        <div className={isDesktop ? "h-full overflow-auto p-2" : "card h-full overflow-auto"}>
          <FileTree
            activePath={openPath}
            onPick={openFile}
            onOpenWorkspace={openWorkspace}
          />
        </div>
      </aside>

      <ResizeHandle
        visible={isDesktop && treeShown}
        value={leftWidth}
        min={LEFT_MIN}
        max={LEFT_MAX}
        onResize={(dx) => setLeftWidth((w) => clamp(w + dx, LEFT_MIN, LEFT_MAX))}
      />

      {/* Center: editor (always mounted) with aux views layered over it */}
      <main
        className={cx(
          "min-w-0 min-h-0 overflow-hidden p-2 sm:p-3",
          centerShown ? "flex-1" : "hidden",
        )}
      >
        <div className={cx("h-full min-h-0", centerView !== "editor" && "hidden")}>
          <FileEditor
            path={openPath}
            activeStoryId={activeStoryId}
            onOpenPath={openFile}
            onDirtyChange={(d) => {
              dirtyRef.current = d;
            }}
          />
        </div>
        <div
          className={cx(
            "h-full min-h-0 flex flex-col",
            centerView === "editor" && "hidden",
          )}
        >
          {centerView !== "editor" && (
            <>
              <div className="flex items-center gap-2 mb-2 px-1">
                <h2 className="font-display text-xl">
                  {VIEW_META[centerView].icon} {VIEW_META[centerView].title}
                </h2>
                <button
                  onClick={() => setCenterView("editor")}
                  className="btn btn-ghost text-xs ml-auto"
                >
                  ‹ Editor
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-auto">
                {VIEW_META[centerView].needsStory && activeStoryId === null ? (
                  <StoryPrompt label={VIEW_META[centerView].title} />
                ) : (
                  <AuxBody
                    view={centerView}
                    activeStoryId={activeStoryId}
                    onBack={() => setCenterView("editor")}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </main>

      <ResizeHandle
        visible={isDesktop && chatShown}
        value={chatWidth}
        min={CHAT_MIN}
        max={CHAT_MAX}
        onResize={(dx) => setChatWidth((w) => clamp(w - dx, CHAT_MIN, CHAT_MAX))}
      />

      {/* Chat */}
      <aside
        className={cx(
          "min-h-0 overflow-hidden p-2",
          chatShown ? (isDesktop ? "shrink-0" : "flex-1") : "hidden",
        )}
        style={isDesktop && chatShown ? { width: chatWidth } : undefined}
      >
        <ChatPanel storyId={activeStoryId} />
      </aside>

      {/* More sheet (mobile only) */}
      <div className={cx("min-h-0 overflow-hidden", moreShown ? "flex-1" : "hidden")}>
        <MoreSheet onPick={goAux} />
      </div>

      {/* Bottom tab bar (mobile only) */}
      <nav
        aria-label="Panes"
        className={cx(
          "shrink-0 grid grid-cols-4 border-t border-bg/10 dark:border-muted/20 bg-paper dark:bg-bg pb-safe",
          isDesktop && "hidden",
        )}
      >
        <MobileTab
          label="Files"
          icon="🗂"
          active={mobilePane === "files"}
          onClick={() => setMobilePane("files")}
        />
        <MobileTab
          label="Editor"
          icon="📝"
          active={editorTabActive}
          onClick={() => {
            setCenterView("editor");
            setMobilePane("editor");
          }}
        />
        <MobileTab
          label="Chat"
          icon="💬"
          active={mobilePane === "chat"}
          onClick={() => setMobilePane("chat")}
        />
        <MobileTab
          label="More"
          icon="⋯"
          active={moreTabActive}
          onClick={() => setMobilePane("more")}
        />
      </nav>
    </div>
  );
}

function AuxBody({
  view,
  activeStoryId,
  onBack,
}: {
  view: AuxView;
  activeStoryId: number | null;
  onBack: () => void;
}) {
  switch (view) {
    case "search":
      return <SearchPanel activeStoryId={activeStoryId} />;
    case "lore":
      return <LoreBrowser />;
    case "canon":
      return <CanonBrowser storyId={activeStoryId as number} />;
    case "history":
      return <SnapshotBrowser storyId={activeStoryId as number} />;
    case "characters":
      return <CharacterTimeline defaultSeries={null} />;
    case "outline":
      return <OutlineView storyId={activeStoryId as number} />;
    case "structure":
      return <StructureBrowser storyId={activeStoryId as number} />;
    case "workflows":
      return (
        <WorkflowRunner
          storyId={activeStoryId as number}
          onComplete={onBack}
          onCancel={onBack}
        />
      );
    case "styles":
      return <StyleBrowser />;
    case "stats":
      return <StatsPanel activeStoryId={activeStoryId} />;
  }
}

function StoryPrompt({ label }: { label: string }) {
  return (
    <div className="max-w-md mx-auto card text-center text-muted py-12">
      Pick a story from the top bar to use {label}.
    </div>
  );
}

function ActivityButton({
  title,
  active,
  onClick,
  children,
  nav,
}: {
  title: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  nav?: boolean;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      aria-pressed={nav ? undefined : active}
      aria-current={nav ? (active ? "page" : undefined) : undefined}
      onClick={onClick}
      className={cx(
        "w-9 h-9 flex items-center justify-center rounded text-lg transition-colors",
        active
          ? "bg-teal text-paper"
          : "text-bg dark:text-paper hover:bg-bg/10 dark:hover:bg-muted/10",
      )}
    >
      {children}
    </button>
  );
}

function ResizeHandle({
  visible,
  value,
  min,
  max,
  onResize,
}: {
  visible: boolean;
  value: number;
  min: number;
  max: number;
  onResize: (deltaX: number) => void;
}) {
  const [drag, setDrag] = useState(false);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize pane"
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={visible ? 0 : -1}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        setDrag(true);
      }}
      onPointerMove={(e) => {
        if (drag && e.movementX !== 0) onResize(e.movementX);
      }}
      onPointerUp={(e) => {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        setDrag(false);
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16;
        if (e.key === "ArrowLeft") {
          onResize(-step);
          e.preventDefault();
        } else if (e.key === "ArrowRight") {
          onResize(step);
          e.preventDefault();
        }
      }}
      className={cx(
        "shrink-0 w-1.5 cursor-col-resize transition-colors",
        !visible && "hidden",
        drag ? "bg-tealBright" : "bg-bg/10 dark:bg-muted/20 hover:bg-tealBright",
      )}
    />
  );
}

function MobileTab({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cx(
        "flex flex-col items-center justify-center gap-0.5 py-2 text-[11px]",
        active
          ? "text-tealBright"
          : "text-muted hover:text-bg dark:hover:text-paper",
      )}
    >
      <span className="text-lg leading-none">{icon}</span>
      {label}
    </button>
  );
}

function MoreSheet({ onPick }: { onPick: (v: AuxView) => void }) {
  return (
    <div className="h-full overflow-auto p-3 space-y-1">
      <h2 className="font-display text-2xl mb-3">More</h2>
      {AUX_ORDER.map((v) => (
        <button
          key={v}
          onClick={() => onPick(v)}
          className="w-full text-left btn btn-ghost text-base py-3 flex items-center gap-3"
        >
          <span className="text-lg">{VIEW_META[v].icon}</span>
          {VIEW_META[v].title}
        </button>
      ))}
    </div>
  );
}
