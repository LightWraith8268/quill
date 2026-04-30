// Inline workflow form. Picks a workflow → renders fields → runs SSE → polls
// chat history for new assistant message at end. Returns to chat view.

import { useEffect, useState } from "react";
import { api, workflowStream, type WorkflowDef } from "../api.ts";

type Props = {
  storyId: number;
  onComplete: () => void;
  onCancel: () => void;
};

export function WorkflowRunner({ storyId, onComplete, onCancel }: Props) {
  const [workflows, setWorkflows] = useState<WorkflowDef[]>([]);
  const [active, setActive] = useState<WorkflowDef | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.workflowList().then((r) => setWorkflows(r.workflows)).catch((e: Error) => setErr(e.message));
  }, []);

  const selectWf = (wf: WorkflowDef) => {
    setActive(wf);
    const init: Record<string, string> = {};
    for (const f of wf.fields) {
      if (f.default !== undefined) init[f.name] = String(f.default);
    }
    setInputs(init);
    setStreamText("");
    setErr(null);
  };

  const run = async () => {
    if (!active) return;
    for (const f of active.fields) {
      if (f.required && !inputs[f.name]?.trim()) {
        setErr(`Required field missing: ${f.label}`);
        return;
      }
    }
    setBusy(true);
    setErr(null);
    setStreamText("");
    try {
      let buf = "";
      for await (const ev of workflowStream(storyId, active.id, inputs)) {
        if (ev.event === "delta") {
          const data = ev.data as { text: string };
          buf += data.text;
          setStreamText(buf);
        } else if (ev.event === "error") {
          const data = ev.data as { error: string };
          throw new Error(data.error);
        } else if (ev.event === "done") {
          // Workflow message + assistant reply persisted server-side.
          onComplete();
          return;
        }
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!active) {
    return (
      <div className="card space-y-3">
        <div className="flex items-center">
          <h2 className="font-display text-xl">Workflows</h2>
          <button onClick={onCancel} className="btn btn-ghost text-xs ml-auto">
            ← Back to chat
          </button>
        </div>
        <p className="text-muted text-sm">
          Specialized prompts pinned to the right agent. Run from the active story
          and reply lands in chat history.
        </p>
        {err && <div className="bg-red-900/40 text-red-200 text-sm p-3 rounded">{err}</div>}
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {workflows.map((wf) => (
            <button
              key={wf.id}
              onClick={() => selectWf(wf)}
              className="text-left p-4 rounded border border-muted/30 hover:border-tealBright/60 hover:bg-bg/40 transition-colors"
            >
              <div className="flex items-baseline gap-2">
                <h3 className="font-display text-lg">{wf.title}</h3>
                <span className="text-xs px-1.5 py-0.5 border border-muted/40 rounded font-mono">
                  {wf.agent}
                </span>
              </div>
              <p className="text-sm text-muted mt-1">{wf.description}</p>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="card space-y-3">
      <div className="flex items-center">
        <h2 className="font-display text-xl">{active.title}</h2>
        <span className="text-xs px-1.5 py-0.5 border border-muted/40 rounded font-mono ml-2">
          {active.agent}
        </span>
        <button
          onClick={() => setActive(null)}
          className="btn btn-ghost text-xs ml-auto"
          disabled={busy}
        >
          ← Pick another
        </button>
      </div>
      <p className="text-sm text-muted">{active.description}</p>

      {active.fields.map((f) => (
        <div key={f.name}>
          <label className="block text-sm text-muted mb-1">
            {f.label} {f.required && <span className="text-red-400">*</span>}
          </label>
          {f.kind === "select" ? (
            <select
              className="input w-full"
              value={inputs[f.name] ?? ""}
              onChange={(e) => setInputs((cur) => ({ ...cur, [f.name]: e.target.value }))}
              disabled={busy}
            >
              {f.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : f.kind === "textarea" ? (
            <textarea
              className="input w-full font-ui resize-none"
              rows={f.rows ?? 4}
              placeholder={f.placeholder}
              value={inputs[f.name] ?? ""}
              onChange={(e) => setInputs((cur) => ({ ...cur, [f.name]: e.target.value }))}
              disabled={busy}
            />
          ) : (
            <input
              className="input w-full"
              type={f.kind === "number" ? "number" : "text"}
              placeholder={f.placeholder}
              value={inputs[f.name] ?? ""}
              onChange={(e) => setInputs((cur) => ({ ...cur, [f.name]: e.target.value }))}
              disabled={busy}
            />
          )}
        </div>
      ))}

      {err && <div className="bg-red-900/40 text-red-200 text-sm p-3 rounded">{err}</div>}

      {streamText && (
        <div className="card bg-bg/60 max-h-80 overflow-auto">
          <div className="text-xs text-tealBright mb-1">Streaming from {active.agent}…</div>
          <pre className="whitespace-pre-wrap font-ui text-sm leading-relaxed">{streamText}</pre>
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={run}
          disabled={busy}
          className="btn btn-primary"
        >
          {busy ? "Running…" : "Run"}
        </button>
        <button onClick={onCancel} disabled={busy} className="btn btn-ghost">
          Cancel
        </button>
      </div>
    </div>
  );
}
