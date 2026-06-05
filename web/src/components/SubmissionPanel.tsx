// Submission pipeline: compile/export the manuscript (md/html/docx/epub),
// generate canon-grounded pitch materials (logline, blurb, synopsis, query
// letter), and track agent submissions and their status.

import { useEffect, useState } from "react";
import { api, type Submission } from "../api.ts";

type Kind = { id: string; label: string; blurb: string };

const STATUSES: Submission["status"][] = [
  "queued",
  "sent",
  "partial",
  "full",
  "rejected",
  "offer",
  "withdrawn",
];

const STATUS_TONE: Record<Submission["status"], string> = {
  queued: "text-muted",
  sent: "text-tealBright",
  partial: "text-amber-500",
  full: "text-amber-400",
  rejected: "text-red-500",
  offer: "text-emerald-500",
  withdrawn: "text-muted",
};

export function SubmissionPanel({ storyId }: { storyId: number }) {
  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <h2 className="font-display text-2xl">Submission</h2>
      <CompileRow storyId={storyId} />
      <MaterialsCard storyId={storyId} />
      <TrackerCard storyId={storyId} />
    </div>
  );
}

function CompileRow({ storyId }: { storyId: number }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const formats: ("md" | "html" | "docx" | "epub")[] = ["md", "html", "docx", "epub"];
  return (
    <div className="card flex flex-wrap items-center gap-2">
      <span className="text-sm font-medium">Compile manuscript</span>
      {formats.map((f) => (
        <button
          key={f}
          className="btn btn-ghost text-xs"
          disabled={busy !== null}
          onClick={async () => {
            setBusy(f);
            setErr(null);
            try {
              await api.compileStory(storyId, f);
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setBusy(null);
            }
          }}
          title={f === "docx" || f === "epub" ? "Requires pandoc on PATH" : undefined}
        >
          {busy === f ? "…" : `⇩ ${f}`}
        </button>
      ))}
      {err && <span className="text-xs text-red-500 w-full">{err}</span>}
    </div>
  );
}

function MaterialsCard({ storyId }: { storyId: number }) {
  const [kinds, setKinds] = useState<Kind[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .submissionMaterialKinds()
      .then((r) => setKinds(r.kinds))
      .catch((e: Error) => setErr(e.message));
  }, []);

  const gen = async (kind: Kind) => {
    if (busy) return;
    setBusy(true);
    setActive(kind.id);
    setErr(null);
    setText("");
    try {
      const r = await api.submissionMaterial(storyId, kind.id);
      setText(r.text);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card space-y-3">
      <div className="flex items-center gap-2">
        <span className="font-display text-lg">Pitch materials</span>
        <span className="text-xs text-muted">drawn from canon + outline</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {kinds.map((k) => (
          <button
            key={k.id}
            onClick={() => gen(k)}
            disabled={busy}
            className={`btn text-xs ${active === k.id ? "btn-primary" : "btn-ghost"}`}
            title={k.blurb}
          >
            {busy && active === k.id ? "Writing…" : k.label}
          </button>
        ))}
      </div>
      {err && (
        <div className="bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200 text-sm p-3 rounded">
          {err}
        </div>
      )}
      {(text || busy) && (
        <div className="space-y-2">
          <textarea
            className="input w-full font-ui resize-y text-sm"
            rows={10}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={busy ? "" : ""}
          />
          <div className="flex">
            <button
              className="btn btn-ghost text-xs ml-auto"
              onClick={() => navigator.clipboard?.writeText(text)}
              disabled={!text}
            >
              Copy
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TrackerCard({ storyId }: { storyId: number }) {
  const [subs, setSubs] = useState<Submission[]>([]);
  const [agent, setAgent] = useState("");
  const [agency, setAgency] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    api
      .submissionsList(storyId)
      .then((r) => setSubs(r.submissions))
      .catch((e: Error) => setErr(e.message));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storyId]);

  const add = async () => {
    if (!agent.trim()) return;
    try {
      await api.submissionCreate(storyId, { agent: agent.trim(), agency: agency.trim() || undefined });
      setAgent("");
      setAgency("");
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const setStatus = async (id: number, status: Submission["status"]) => {
    try {
      await api.submissionUpdate(id, { status });
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const remove = async (id: number) => {
    try {
      await api.submissionDelete(id);
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="card space-y-3">
      <span className="font-display text-lg">Submission tracker</span>
      {err && (
        <div className="bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200 text-sm p-3 rounded">
          {err}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <input
          className="input flex-1 min-w-[8rem]"
          placeholder="Agent name"
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
        />
        <input
          className="input flex-1 min-w-[8rem]"
          placeholder="Agency (optional)"
          value={agency}
          onChange={(e) => setAgency(e.target.value)}
        />
        <button className="btn btn-primary text-sm" onClick={add} disabled={!agent.trim()}>
          Add
        </button>
      </div>
      {subs.length === 0 ? (
        <p className="text-muted text-sm">No submissions tracked yet.</p>
      ) : (
        <ul className="space-y-1">
          {subs.map((s) => (
            <li key={s.id} className="flex items-center gap-2 text-sm border-b border-muted/15 py-1.5">
              <span className="font-medium truncate">{s.agent}</span>
              {s.agency && <span className="text-muted text-xs truncate">{s.agency}</span>}
              <select
                className="input text-xs ml-auto py-1"
                value={s.status}
                onChange={(e) => setStatus(s.id, e.target.value as Submission["status"])}
              >
                {STATUSES.map((st) => (
                  <option key={st} value={st}>
                    {st}
                  </option>
                ))}
              </select>
              <span className={`text-xs ${STATUS_TONE[s.status]}`}>●</span>
              <button
                className="text-muted hover:text-red-500 text-xs"
                onClick={() => remove(s.id)}
                aria-label="Delete"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
