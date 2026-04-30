// Research clipper modal: paste URL, agent fetches + saves to Research/.

import { useState } from "react";
import { api } from "../api.ts";

type Props = { onClose: () => void; onClipped: (path: string) => void };

export function ResearchClipModal({ onClose, onClipped }: Props) {
  const [url, setUrl] = useState("");
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ vaultPath: string; title: string } | null>(null);

  const clip = async () => {
    if (!url.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.clipUrl(url.trim(), topic.trim() || undefined);
      setResult({ vaultPath: r.vaultPath, title: r.title });
      onClipped(r.vaultPath);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center pt-[15vh] p-3">
      <div className="card w-full max-w-md space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-xl">Research clipper</h2>
          <button onClick={onClose} className="btn btn-ghost text-xs ml-auto">Close</button>
        </div>
        <input
          className="input w-full"
          autoFocus
          placeholder="https://…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy}
        />
        <input
          className="input w-full"
          placeholder="Topic (optional, used for filename)"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          disabled={busy}
        />
        {err && (
          <div className="bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200 text-sm p-2 rounded">
            {err}
          </div>
        )}
        {result && (
          <div className="text-xs text-muted">
            Saved to <code className="text-tealBright">{result.vaultPath}</code>
          </div>
        )}
        <div className="flex gap-2 justify-end">
          <button onClick={clip} disabled={busy || !url.trim()} className="btn btn-primary">
            {busy ? "Fetching…" : "Clip"}
          </button>
        </div>
      </div>
    </div>
  );
}
