// Editorial passes with tracked changes. Pick a pass (tighten, dialogue,
// sensory, pacing, line-edit); the revised text comes back and is diffed into
// hunks the writer accepts or rejects individually. Applying reconstructs the
// file from the chosen hunks and writes it back into the editor.

import { useEffect, useMemo, useState } from "react";
import { diffLines } from "diff";
import { api, type EditorialPassMeta } from "../api.ts";

type Segment =
  | { type: "context"; text: string }
  | { type: "hunk"; id: number; removed: string; added: string };

function buildSegments(orig: string, revised: string): Segment[] {
  const changes = diffLines(orig, revised);
  const segs: Segment[] = [];
  let i = 0;
  let hunkId = 0;
  while (i < changes.length) {
    const ch = changes[i]!;
    if (!ch.added && !ch.removed) {
      segs.push({ type: "context", text: ch.value });
      i++;
      continue;
    }
    let removed = "";
    let added = "";
    while (i < changes.length && (changes[i]!.added || changes[i]!.removed)) {
      if (changes[i]!.removed) removed += changes[i]!.value;
      else added += changes[i]!.value;
      i++;
    }
    segs.push({ type: "hunk", id: hunkId++, removed, added });
  }
  return segs;
}

function reconstruct(segs: Segment[], accepted: Set<number>): string {
  return segs
    .map((s) =>
      s.type === "context" ? s.text : accepted.has(s.id) ? s.added : s.removed
    )
    .join("");
}

function lines(s: string): string[] {
  const l = s.split("\n");
  if (l.length > 1 && l[l.length - 1] === "") l.pop();
  return l;
}

export function EditorialPanel({
  storyId,
  getText,
  onApply,
  onClose,
}: {
  storyId: number | null;
  getText: () => string;
  onApply: (text: string) => void;
  onClose: () => void;
}) {
  const [passes, setPasses] = useState<EditorialPassMeta[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [original, setOriginal] = useState("");
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [accepted, setAccepted] = useState<Set<number>>(() => new Set());
  const [activePass, setActivePass] = useState<EditorialPassMeta | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .editPasses()
      .then((r) => setPasses(r.passes))
      .catch((e: Error) => setErr(e.message));
  }, []);

  const hunks = useMemo(
    () => (segments ?? []).filter((s): s is Extract<Segment, { type: "hunk" }> => s.type === "hunk"),
    [segments]
  );

  const run = async (pass: EditorialPassMeta) => {
    if (running) return;
    const text = getText();
    if (!text.trim()) {
      setErr("Nothing to edit.");
      return;
    }
    setRunning(pass.id);
    setErr(null);
    setSegments(null);
    setActivePass(pass);
    try {
      const r = await api.editPass(text, pass.id, storyId ?? undefined);
      const segs = buildSegments(text, r.revised);
      setOriginal(text);
      setSegments(segs);
      // Accept all by default — the writer rejects what they don't want.
      setAccepted(new Set(segs.filter((s) => s.type === "hunk").map((s) => (s as { id: number }).id)));
    } catch (ex) {
      setErr((ex as Error).message);
      setActivePass(null);
    } finally {
      setRunning(null);
    }
  };

  const toggle = (id: number) =>
    setAccepted((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const apply = () => {
    if (!segments) return;
    onApply(reconstruct(segments, accepted));
    onClose();
  };

  const acceptedCount = accepted.size;

  return (
    <div className="card space-y-3">
      <div className="flex items-center gap-2">
        <span className="font-display text-lg">Editorial passes</span>
        {activePass && segments && (
          <span className="text-xs text-muted">
            {activePass.label} · {hunks.length} change{hunks.length === 1 ? "" : "s"} ·{" "}
            {acceptedCount} accepted
          </span>
        )}
        <button onClick={onClose} className="btn btn-ghost text-xs ml-auto">
          Close
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {passes.map((p) => (
          <button
            key={p.id}
            onClick={() => run(p)}
            disabled={running !== null}
            className={`btn text-xs ${activePass?.id === p.id ? "btn-primary" : "btn-ghost"}`}
            title={p.blurb}
          >
            {running === p.id ? "Revising…" : p.label}
          </button>
        ))}
      </div>

      {err && (
        <div className="bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200 text-sm p-3 rounded">
          {err}
        </div>
      )}

      {segments && hunks.length === 0 && (
        <p className="text-muted text-sm">
          This pass suggested no changes — the text already reads well for it.
        </p>
      )}

      {segments && hunks.length > 0 && (
        <>
          <div className="max-h-[28rem] overflow-auto font-mono text-xs leading-relaxed space-y-1">
            {segments.map((s, idx) =>
              s.type === "context" ? (
                <ContextBlock key={`c${idx}`} text={s.text} />
              ) : (
                <div
                  key={`h${s.id}`}
                  className={`rounded border ${
                    accepted.has(s.id)
                      ? "border-tealBright/40"
                      : "border-muted/30 opacity-60"
                  }`}
                >
                  <div className="flex items-center gap-2 px-2 py-1 bg-bg/40 dark:bg-bg/60">
                    <span className="text-[10px] uppercase text-muted">
                      change {s.id + 1}
                    </span>
                    <label className="ml-auto flex items-center gap-1 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={accepted.has(s.id)}
                        onChange={() => toggle(s.id)}
                        className="accent-teal"
                      />
                      <span className="text-[11px]">{accepted.has(s.id) ? "accept" : "reject"}</span>
                    </label>
                  </div>
                  {lines(s.removed).map((l, i) => (
                    <div
                      key={`r${i}`}
                      className="bg-red-100 dark:bg-red-900/30 text-red-900 dark:text-red-200 whitespace-pre-wrap break-words px-2"
                    >
                      <span className="select-none mr-2">−</span>
                      {l}
                    </div>
                  ))}
                  {lines(s.added).map((l, i) => (
                    <div
                      key={`a${i}`}
                      className="bg-green-100 dark:bg-green-900/30 text-green-900 dark:text-green-200 whitespace-pre-wrap break-words px-2"
                    >
                      <span className="select-none mr-2">+</span>
                      {l}
                    </div>
                  ))}
                </div>
              )
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              className="btn btn-ghost text-xs"
              onClick={() => setAccepted(new Set(hunks.map((h) => h.id)))}
            >
              Accept all
            </button>
            <button className="btn btn-ghost text-xs" onClick={() => setAccepted(new Set())}>
              Reject all
            </button>
            <button className="btn btn-primary text-sm ml-auto" onClick={apply}>
              Apply {acceptedCount} change{acceptedCount === 1 ? "" : "s"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ContextBlock({ text }: { text: string }) {
  const all = lines(text);
  const [open, setOpen] = useState(false);
  if (all.length <= 4) {
    return (
      <div className="text-muted whitespace-pre-wrap break-words px-2">
        {all.map((l, i) => (
          <div key={i}>
            <span className="select-none mr-2">·</span>
            {l}
          </div>
        ))}
      </div>
    );
  }
  const head = all.slice(0, 2);
  const tail = all.slice(-2);
  const mid = all.slice(2, -2);
  return (
    <div className="text-muted whitespace-pre-wrap break-words px-2">
      {head.map((l, i) => (
        <div key={`h${i}`}>
          <span className="select-none mr-2">·</span>
          {l}
        </div>
      ))}
      {open ? (
        mid.map((l, i) => (
          <div key={`m${i}`}>
            <span className="select-none mr-2">·</span>
            {l}
          </div>
        ))
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="italic hover:text-tealBright py-0.5"
        >
          … {mid.length} unchanged lines
        </button>
      )}
      {tail.map((l, i) => (
        <div key={`t${i}`}>
          <span className="select-none mr-2">·</span>
          {l}
        </div>
      ))}
    </div>
  );
}
