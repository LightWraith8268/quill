// Cmd+K rewrite modal. Streams a rewrite of the selection per a user-supplied
// instruction (or preset). Caller decides accept/reject.

import { useEffect, useState } from "react";
import { inlineEditStream } from "../api.ts";

const PRESETS: { label: string; instruction: string }[] = [
  { label: "Tighten", instruction: "Tighten this. Remove every word that isn't load-bearing. Keep voice and meaning." },
  { label: "Punch up dialogue", instruction: "Punch up the dialogue. Sharper subtext, character-distinct registers, less on-the-nose." },
  { label: "Show, don't tell", instruction: "Convert any explanation into shown action, image, or dialogue. Keep meaning intact." },
  { label: "Cut em-dashes", instruction: "Remove em-dashes. Use commas, periods, or restructure. Keep voice intact." },
  { label: "Vesper register", instruction: "Rewrite Vesper-9's lines as *ALL CAPS ITALIC*, no contractions, three-millisecond pauses where load-bearing." },
  { label: "Add sensory detail", instruction: "Add concrete sensory detail (sight + kinesthetic) without slowing pace." },
];

type Props = {
  selection: string;
  storyId?: number | null;
  onAccept: (replacement: string) => void;
  onCancel: () => void;
};

export function InlineRewriteModal({ selection, storyId, onAccept, onCancel }: Props) {
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const run = async (instr: string) => {
    if (!instr.trim()) return;
    setBusy(true);
    setErr(null);
    setResult("");
    try {
      let buf = "";
      for await (const ev of inlineEditStream(selection, instr.trim(), storyId ?? undefined)) {
        if (ev.event === "delta") {
          const data = ev.data as { text: string };
          buf += data.text;
          setResult(buf);
        } else if (ev.event === "error") {
          throw new Error((ev.data as { error: string }).error);
        }
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center pt-[10vh] p-3">
      <div className="card w-full max-w-3xl max-h-[80vh] overflow-auto space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-xl">⌘K Rewrite</h2>
          <button onClick={onCancel} className="btn btn-ghost text-xs ml-auto">
            Esc
          </button>
        </div>
        <details className="text-xs">
          <summary className="cursor-pointer text-muted">
            Selection ({selection.length} chars)
          </summary>
          <pre className="whitespace-pre-wrap font-ui mt-2">{selection}</pre>
        </details>
        <div className="flex flex-wrap gap-1">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => {
                setInstruction(p.instruction);
                run(p.instruction);
              }}
              disabled={busy}
              className="px-2 py-1 text-xs rounded border border-muted/30 hover:border-tealBright/60 hover:text-tealBright"
            >
              {p.label}
            </button>
          ))}
        </div>
        <textarea
          className="input w-full font-ui resize-none"
          rows={2}
          autoFocus
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Custom instruction… (Enter to run)"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              run(instruction);
            }
          }}
          disabled={busy}
        />
        {err && (
          <div className="bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200 text-sm p-3 rounded">
            {err}
          </div>
        )}
        {result && (
          <div className="card bg-paper/40 dark:bg-bg/60 max-h-80 overflow-auto">
            <div className="text-xs text-tealBright mb-1">
              {busy ? "Streaming…" : "Rewrite (preview)"}
            </div>
            <pre className="whitespace-pre-wrap font-ui text-sm">{result}</pre>
          </div>
        )}
        {result && !busy && (
          <div className="flex gap-2 justify-end">
            <button onClick={onCancel} className="btn btn-ghost">
              Reject
            </button>
            <button onClick={() => onAccept(result)} className="btn btn-primary">
              Accept (replace selection)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
