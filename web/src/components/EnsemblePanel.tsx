// 3-column ensemble view. Fires the same prompt at all 3 agents; each column
// streams its own deltas. User picks a winner (or none) and dismisses.

import { useState } from "react";
import { ensembleStream, type AgentName } from "../api.ts";
import { MarkdownView } from "./MarkdownView.tsx";

type Props = {
  storyId: number;
  prompt: string;
  onClose: () => void;
};

const AGENTS: AgentName[] = ["claude", "codex", "gemini"];

type AgentBucket = {
  text: string;
  status: "idle" | "running" | "done" | "error";
  error?: string;
  assistantId?: number;
};

const initial: Record<AgentName, AgentBucket> = {
  claude: { text: "", status: "idle" },
  codex: { text: "", status: "idle" },
  gemini: { text: "", status: "idle" },
};

export function EnsemblePanel({ storyId, prompt, onClose }: Props) {
  const [results, setResults] = useState<Record<AgentName, AgentBucket>>(initial);
  const [running, setRunning] = useState(false);
  const [allDone, setAllDone] = useState(false);

  const run = async () => {
    setResults(initial);
    setRunning(true);
    setAllDone(false);
    try {
      for await (const ev of ensembleStream(storyId, prompt)) {
        const data = ev.data as {
          type: string;
          agent?: AgentName;
          text?: string;
          error?: string;
          assistantId?: number;
        };
        if (data.type === "agent_start" && data.agent) {
          setResults((cur) => ({
            ...cur,
            [data.agent!]: { text: "", status: "running" },
          }));
        } else if (data.type === "agent_delta" && data.agent && data.text) {
          setResults((cur) => ({
            ...cur,
            [data.agent!]: {
              ...cur[data.agent!],
              text: cur[data.agent!].text + data.text!,
              status: "running",
            },
          }));
        } else if (data.type === "agent_done" && data.agent) {
          setResults((cur) => ({
            ...cur,
            [data.agent!]: {
              ...cur[data.agent!],
              status: "done",
              assistantId: data.assistantId,
            },
          }));
        } else if (data.type === "agent_error" && data.agent) {
          setResults((cur) => ({
            ...cur,
            [data.agent!]: {
              ...cur[data.agent!],
              status: "error",
              error: data.error,
            },
          }));
        } else if (data.type === "all_done") {
          setAllDone(true);
        }
      }
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-3">
      <div className="card w-full max-w-7xl max-h-[90vh] overflow-auto space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-2xl">Ensemble</h2>
          <span className="text-xs text-muted">
            All 3 agents, same prompt, side-by-side.
          </span>
          <button onClick={onClose} className="btn btn-ghost text-xs ml-auto">
            Close
          </button>
        </div>
        <div className="text-xs text-muted">
          <span className="text-tealBright">Prompt:</span> {prompt.slice(0, 200)}
          {prompt.length > 200 && "…"}
        </div>
        {!running && !allDone && (
          <button onClick={run} className="btn btn-primary">
            Run all 3
          </button>
        )}
        {(running || allDone) && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {AGENTS.map((ag) => {
              const r = results[ag];
              return (
                <div key={ag} className="card flex flex-col min-h-[40vh]">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="font-mono text-tealBright capitalize">
                      {ag}
                    </span>
                    <span className="text-xs text-muted ml-auto">
                      {r.status === "running" && "streaming…"}
                      {r.status === "done" && "✓ done"}
                      {r.status === "error" && "⚠ error"}
                    </span>
                  </div>
                  {r.error && (
                    <div className="bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200 text-xs p-2 rounded">
                      {r.error}
                    </div>
                  )}
                  <div className="flex-1 overflow-auto text-sm">
                    {r.status === "running" ? (
                      <pre className="whitespace-pre-wrap font-ui">{r.text}</pre>
                    ) : (
                      <MarkdownView content={r.text} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {allDone && (
          <p className="text-xs text-muted">
            All 3 are persisted to chat history. Use Rerun on a bubble to refine
            a winning take.
          </p>
        )}
      </div>
    </div>
  );
}
