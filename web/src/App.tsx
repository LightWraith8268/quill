import { useEffect, useState } from "react";
import { api, auth, type Story } from "./api.ts";
import { Login } from "./components/Login.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { StoryPicker } from "./components/StoryPicker.tsx";
import { IdeShell } from "./components/IdeShell.tsx";
import { recentWorkspaces } from "./recents.ts";

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

// code-server-style deep link: ?folder=/abs/path (or a writing-root-relative
// path) opens that folder as the active workspace on load.
function getFolderParam(): string | null {
  if (typeof window === "undefined") return null;
  const m = window.location.search.match(/(?:^|[?&])folder=([^&]+)/);
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

  // ?folder=<path> deep link: open that folder as the active workspace.
  useEffect(() => {
    if (!authed) return;
    const folder = getFolderParam();
    if (!folder) return;
    api
      .openWorkspace(folder)
      .then((r) => {
        setActiveStoryId(r.story.id);
        recentWorkspaces.push({ path: r.story.path, name: r.story.name, ts: Date.now() });
      })
      .catch((e: Error) => setBootError(`open folder failed: ${e.message}`));
  }, [authed]);

  if (shareToken) return <ShareView token={shareToken} />;

  if (!authed) {
    return <Login onAuthed={() => setAuthed(true)} />;
  }

  return (
    <div className="h-full flex flex-col">
      <TopBar
        onLogout={() => {
          auth.set("");
          setAuthed(false);
        }}
        storyPicker={
          <StoryPicker
            activeStoryId={activeStoryId}
            onPick={(s: Story) => setActiveStoryId(s.id)}
          />
        }
      />
      {bootError && (
        <div className="bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200 text-sm px-4 py-2 border-b border-red-300/60 dark:border-red-800/50">
          API unreachable: {bootError}
        </div>
      )}
      <div className="flex-1 min-h-0">
        <IdeShell
          activeStoryId={activeStoryId}
          setActiveStoryId={setActiveStoryId}
          onError={setBootError}
        />
      </div>
    </div>
  );
}
