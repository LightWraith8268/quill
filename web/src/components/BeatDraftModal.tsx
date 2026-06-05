// "Draft this beat" modal. Streams a scene drafted from an outline node's full
// context pack (beat intent + style + in-scope canon + prior scene's ending),
// then lets the writer insert it into a manuscript file. On insert the node is
// marked drafted and linked to the file.

import { useEffect, useRef, useState } from "react";
import { api, draftBeatStream, type OutlineNode } from "../api.ts";
import { InsertModal } from "./InsertModal.tsx";

export function BeatDraftModal({
  storyId,
  node,
  defaultDir,
  onClose,
  onDrafted,
}: {
  storyId: number;
  node: OutlineNode;
  defaultDir: string;
  onClose: () => void;
  onDrafted?: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [inserting, setInserting] = useState(false);
  const startedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    (async () => {
      try {
        for await (const ev of draftBeatStream(storyId, node.id)) {
          if (ev.event === "delta") {
            setText((t) => t + (ev.data as { text: string }).text);
          } else if (ev.event === "error") {
            setErr((ev.data as { error: string }).error);
            break;
          }
        }
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  }, [storyId, node.id]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [text]);

  const suggestedName = node.title.replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center pt-[6vh] p-3">
      <div className="card w-full max-w-3xl max-h-[86vh] flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-xl">Draft: {node.title}</h2>
          {busy && <span className="text-xs text-tealBright animate-pulse">drafting…</span>}
          <button onClick={onClose} className="btn btn-ghost text-xs ml-auto">
            Close
          </button>
        </div>

        {node.summary && (
          <p className="text-xs text-muted border-l-2 border-muted/30 pl-2">{node.summary}</p>
        )}

        {err && (
          <div className="bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200 text-sm p-3 rounded">
            {err}
          </div>
        )}

        <div ref={scrollRef} className="flex-1 overflow-auto card bg-paper/40 dark:bg-bg/60">
          <pre className="whitespace-pre-wrap font-ui leading-relaxed text-sm">
            {text || (busy ? "" : "(no output)")}
          </pre>
        </div>

        <div className="flex items-center gap-2">
          <button
            className="btn btn-ghost text-xs"
            onClick={() => navigator.clipboard?.writeText(text)}
            disabled={!text}
          >
            Copy
          </button>
          <button
            className="btn btn-primary text-sm ml-auto"
            onClick={() => setInserting(true)}
            disabled={busy || !text.trim()}
          >
            Insert into file…
          </button>
        </div>
      </div>

      {inserting && (
        <InsertModal
          text={text}
          defaultPath={`${defaultDir.replace(/\/$/, "")}/${suggestedName || "scene"}.md`}
          onClose={() => setInserting(false)}
          onInserted={async (path) => {
            try {
              await api.outlineUpdate(node.id, { status: "drafted", manuscript_path: path });
            } catch {
              /* non-fatal */
            }
            onDrafted?.();
            onClose();
          }}
        />
      )}
    </div>
  );
}
