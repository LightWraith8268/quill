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

type Tab = "chat" | "workflows" | "search" | "vault" | "lore" | "styles" | "stats";

const ACTIVE_STORY_KEY = "quill.activeStoryId";

function loadActiveStoryId(): number | null {
  const v = localStorage.getItem(ACTIVE_STORY_KEY);
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export default function App() {
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

  const onPickStory = (s: Story) => {
    setActiveStoryId(s.id);
    setTab("chat");
  };

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
        <div className="bg-red-900/40 text-red-200 text-sm px-4 py-2 border-b border-red-800/50">
          API unreachable: {bootError}
        </div>
      )}
      <main className="flex-1 overflow-auto p-6">
        {tab === "chat" && <ChatPanel storyId={activeStoryId} />}
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
        {tab === "search" && <SearchPanel />}
        {tab === "vault" && <VaultBrowser />}
        {tab === "lore" && <LoreBrowser />}
        {tab === "styles" && <StyleBrowser />}
        {tab === "stats" && <StatsPanel />}
      </main>
    </div>
  );
}
