import { useEffect, useState } from "react";
import { api, auth, type Story } from "./api.ts";
import { Login } from "./components/Login.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { SearchPanel } from "./components/SearchPanel.tsx";
import { StyleBrowser } from "./components/StyleBrowser.tsx";
import { StatsPanel } from "./components/StatsPanel.tsx";
import { ChatPanel } from "./components/ChatPanel.tsx";
import { StoryPicker } from "./components/StoryPicker.tsx";
import { WorkflowRunner } from "./components/WorkflowRunner.tsx";
import { VaultBrowser } from "./components/VaultBrowser.tsx";
import { LoreBrowser } from "./components/LoreBrowser.tsx";
import { CharacterTimeline } from "./components/CharacterTimeline.tsx";
import { OutlineView } from "./components/OutlineView.tsx";
import { VAULT_NAV_EVENT, VAULT_PENDING_KEY } from "./citations.ts";

type Tab =
  | "chat"
  | "outline"
  | "workflows"
  | "search"
  | "vault"
  | "lore"
  | "characters"
  | "styles"
  | "stats";

const ACTIVE_STORY_KEY = "quill.activeStoryId";

function loadActiveStoryId(): number | null {
  const v = localStorage.getItem(ACTIVE_STORY_KEY);
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function getShareToken(): string | null {
  if (typeof window === "undefined") return null;
  const m = window.location.search.match(/(?:^|[?&])share=([^&]+)/);
  return m ? decodeURIComponent(m[1]!) : null;
}

function ShareView({ token }: { token: string }) {
  const [data, setData] = useState<{ label: string | null; filePath: string; content: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/share/${encodeURIComponent(token)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      })
      .then(setData)
      .catch((e: Error) => setErr(e.message));
  }, [token]);
  if (err) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <p className="text-red-300">{err}</p>
      </div>
    );
  }
  if (!data) return <div className="p-6 text-muted">Loading…</div>;
  return (
    <div className="max-w-3xl mx-auto p-6">
      <h1 className="font-display text-3xl mb-4">{data.label ?? data.filePath}</h1>
      <pre className="whitespace-pre-wrap font-ui leading-relaxed">{data.content}</pre>
    </div>
  );
}

export default function App() {
  const shareToken = getShareToken();
  const [authed, setAuthed] = useState<boolean>(Boolean(auth.get()));
  const [tab, setTab] = useState<Tab>("chat");
  const [bootError, setBootError] = useState<string | null>(null);
  const [activeStoryId, setActiveStoryId] = useState<number | null>(loadActiveStoryId);

  useEffect(() => {
    if (!authed) return;
    api
      .health()
      .then(() => setBootError(null))
      .catch((e: Error) => {
        setBootError(e.message);
        if (e.message.startsWith("401")) {
          auth.set("");
          setAuthed(false);
        }
      });
  }, [authed]);

  useEffect(() => {
    if (activeStoryId !== null) {
      localStorage.setItem(ACTIVE_STORY_KEY, String(activeStoryId));
    } else {
      localStorage.removeItem(ACTIVE_STORY_KEY);
    }
  }, [activeStoryId]);

  // Cross-tab nav: chat citations dispatch quill:navigate-vault. Switch tabs;
  // the requested path is stashed in localStorage by the helper for VaultBrowser
  // to pick up. (VaultBrowser wiring lands in a follow-up phase.)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ path?: string }>).detail;
      if (detail?.path) {
        try {
          localStorage.setItem(VAULT_PENDING_KEY, detail.path);
        } catch {
          // ignore storage failures
        }
      }
      setTab("vault");
    };
    window.addEventListener(VAULT_NAV_EVENT, handler);
    return () => window.removeEventListener(VAULT_NAV_EVENT, handler);
  }, []);

  const onPickStory = (s: Story) => {
    setActiveStoryId(s.id);
    setTab("chat");
  };

  if (shareToken) return <ShareView token={shareToken} />;

  if (!authed) {
    return <Login onAuthed={() => setAuthed(true)} />;
  }

  return (
    <div className="h-full flex flex-col">
      <TopBar
        tab={tab}
        setTab={setTab}
        onLogout={() => {
          auth.set("");
          setAuthed(false);
        }}
        storyPicker={
          <StoryPicker activeStoryId={activeStoryId} onPick={onPickStory} />
        }
      />
      {bootError && (
        <div className="bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200 text-sm px-4 py-2 border-b border-red-300/60 dark:border-red-800/50">
          API unreachable: {bootError}
        </div>
      )}
      <main className="flex-1 overflow-auto p-3 sm:p-6">
        {tab === "chat" && <ChatPanel storyId={activeStoryId} />}
        {tab === "outline" &&
          (activeStoryId ? (
            <OutlineView storyId={activeStoryId} />
          ) : (
            <div className="max-w-3xl mx-auto card text-center text-muted py-12">
              Pick a story to outline.
            </div>
          ))}
        {tab === "workflows" &&
          (activeStoryId ? (
            <div className="max-w-5xl mx-auto">
              <WorkflowRunner
                storyId={activeStoryId}
                onComplete={() => setTab("chat")}
                onCancel={() => setTab("chat")}
              />
            </div>
          ) : (
            <div className="max-w-3xl mx-auto card text-center text-muted py-12">
              Pick a story from the top bar to run workflows.
            </div>
          ))}
        {tab === "search" && <SearchPanel activeStoryId={activeStoryId} />}
        {tab === "vault" && <VaultBrowser />}
        {tab === "lore" && <LoreBrowser />}
        {tab === "characters" && (
          <CharacterTimeline defaultSeries={null} />
        )}
        {tab === "styles" && <StyleBrowser />}
        {tab === "stats" && <StatsPanel activeStoryId={activeStoryId} />}
      </main>
    </div>
  );
}
