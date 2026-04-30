import { useState } from "react";
import { auth } from "../api.ts";

export function Login(props: { onAuthed: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!token.trim()) return;
    setBusy(true);
    setErr(null);
    auth.set(token.trim());
    try {
      const res = await fetch("/api/stats", {
        headers: { Authorization: `Bearer ${token.trim()}` },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      props.onAuthed();
    } catch (e) {
      auth.set("");
      setErr((e as Error).message || "auth failed");
      setBusy(false);
    }
  };

  return (
    <div className="h-full flex items-center justify-center">
      <div className="card w-full max-w-md">
        <h1 className="font-display text-3xl mb-1">
          Quill <span className="italic text-tealBright">&</span> the Vault
        </h1>
        <p className="text-muted text-sm mb-6">Enter API token to continue.</p>
        <input
          type="password"
          autoFocus
          className="input w-full mb-3"
          placeholder="HTTP_TOKEN"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <button
          className="btn btn-primary w-full"
          disabled={busy || !token.trim()}
          onClick={submit}
        >
          {busy ? "Verifying…" : "Unlock"}
        </button>
        {err && <div className="text-red-400 text-sm mt-3">{err}</div>}
      </div>
    </div>
  );
}
