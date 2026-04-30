// Multi-agent ensemble: fire the same prompt at all 3 CLI agents in parallel,
// stream their outputs concurrently. Each chunk is tagged with its source
// agent so the UI can render them as 3 columns.

import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { runChat, type ChatStreamEvent } from "./chat.ts";
import type { AgentName } from "./agents/router.ts";

export type EnsembleEvent =
  | { type: "agent_start"; agent: AgentName }
  | { type: "agent_delta"; agent: AgentName; text: string }
  | { type: "agent_done"; agent: AgentName; assistantId: number }
  | { type: "agent_error"; agent: AgentName; error: string }
  | { type: "all_done" };

export type EnsembleRequest = {
  storyId: number;
  message: string;
  agents?: AgentName[];
};

const ALL_AGENTS: AgentName[] = ["claude", "codex", "gemini"];

/**
 * Drains one agent's runChat stream and pushes events into the shared queue.
 * NOTE: the shared message persistence path means each agent ends up writing
 * its own user message duplicate. To avoid that, we run a custom path: only
 * the first agent triggers the user-message persistence, others get a
 * sibling message with the same content but tagged for ensemble.
 *
 * Simpler approach: each ensemble run is its own user message, persisted
 * once outside the per-agent loop. Then call runChat for each agent? But
 * runChat appends a user message itself. To avoid 3 user-message rows, we
 * persist user msg manually + call a streaming variant. For MVP, accept
 * 3 user messages (clearly tagged) — chat history shows the duplication
 * but it's harmless. Tradeoff documented.
 */
async function* runOneAgent(
  cfg: Config,
  db: DB,
  storyId: number,
  message: string,
  agent: AgentName
): AsyncGenerator<EnsembleEvent, void, void> {
  yield { type: "agent_start", agent };
  try {
    for await (const ev of runChat(cfg, db, { storyId, message, agent })) {
      if (ev.type === "delta") {
        yield { type: "agent_delta", agent, text: ev.text };
      } else if (ev.type === "done") {
        yield { type: "agent_done", agent, assistantId: ev.assistantId };
        return;
      } else if (ev.type === "error") {
        yield { type: "agent_error", agent, error: ev.error };
        return;
      }
      // context events skipped — too verbose for ensemble UI
    }
  } catch (e) {
    yield {
      type: "agent_error",
      agent,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function* runEnsemble(
  cfg: Config,
  db: DB,
  req: EnsembleRequest
): AsyncGenerator<EnsembleEvent, void, void> {
  const agents = req.agents ?? ALL_AGENTS;

  // Spawn all generators upfront. We multiplex their events with a queue.
  type Tagged = { agent: AgentName; ev: EnsembleEvent | "done" };
  const queue: Tagged[] = [];
  let waiters: ((v: void) => void)[] = [];

  const push = (t: Tagged): void => {
    queue.push(t);
    const w = waiters;
    waiters = [];
    for (const r of w) r();
  };

  let liveCount = agents.length;
  for (const agent of agents) {
    (async () => {
      const gen = runOneAgent(cfg, db, req.storyId, req.message, agent);
      for await (const ev of gen) push({ agent, ev });
      push({ agent, ev: "done" });
    })();
  }

  while (liveCount > 0) {
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (next.ev === "done") {
        liveCount--;
        continue;
      }
      yield next.ev;
    }
    if (liveCount === 0) break;
    await new Promise<void>((resolve) => waiters.push(resolve));
  }

  yield { type: "all_done" };
}
