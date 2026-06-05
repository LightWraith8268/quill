// Multi-agent ensemble: fire the same prompt at all 3 CLI agents in parallel,
// stream their outputs concurrently. Each chunk is tagged with its source
// agent so the UI can render them as 3 columns.

import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { runChat } from "./chat.ts";
import { claudeStream } from "./agents/claude.ts";
import { makeRecorder } from "./usage.ts";
import type { AgentName } from "./agents/router.ts";

export type EnsembleEvent =
  | { type: "agent_start"; agent: AgentName; role?: string }
  | { type: "agent_delta"; agent: AgentName; text: string }
  | { type: "agent_done"; agent: AgentName; assistantId: number }
  | { type: "agent_error"; agent: AgentName; error: string }
  | { type: "synthesis_start" }
  | { type: "synthesis_delta"; text: string }
  | { type: "synthesis_done" }
  | { type: "all_done" };

export type EnsembleRequest = {
  storyId: number;
  message: string;
  agents?: AgentName[];
  // Writers' room: give each agent a distinct role instead of the same prompt,
  // then (optionally) synthesize a merged result from all three.
  roles?: boolean;
  synthesize?: boolean;
};

const ALL_AGENTS: AgentName[] = ["claude", "codex", "gemini"];

// Writers' room roles. Each agent is briefed for what it's best at; the request
// is appended. Claude drafts; Gemini (long context) guards series continuity;
// Codex critiques structure.
export const ENSEMBLE_ROLES: Record<AgentName, { role: string; brief: string }> = {
  claude: {
    role: "Drafter",
    brief:
      "You are the DRAFTER in a writers' room. Actually write the prose the request calls for, in the story's voice and style, consistent with the canon you're given. Produce usable text, not notes.",
  },
  gemini: {
    role: "Continuity",
    brief:
      "You are the CONTINUITY editor in a writers' room. Do NOT draft prose. Check the request and the canon/context for continuity risks: contradictions, timeline problems, characters knowing things too early, world-rule violations. List concrete issues and the safe constraints any draft must respect.",
  },
  codex: {
    role: "Story Architect",
    brief:
      "You are the STORY ARCHITECT in a writers' room. Do NOT draft finished prose. Critique the structure and propose 2-3 alternative approaches (beat order, tension, POV, what to cut/add) for the request. Be concrete and opinionated.",
  },
};

function roleMessage(agent: AgentName, message: string): string {
  const r = ENSEMBLE_ROLES[agent];
  return `${r.brief}\n\n=== REQUEST ===\n${message}`;
}

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
  agent: AgentName,
  roles: boolean
): AsyncGenerator<EnsembleEvent, void, void> {
  yield { type: "agent_start", agent, role: roles ? ENSEMBLE_ROLES[agent].role : undefined };
  const sent = roles ? roleMessage(agent, message) : message;
  try {
    for await (const ev of runChat(cfg, db, { storyId, message: sent, agent })) {
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

  // Accumulate each agent's full output so a synthesis pass can merge them.
  const outputs = new Map<AgentName, string>();

  let liveCount = agents.length;
  for (const agent of agents) {
    (async () => {
      const gen = runOneAgent(cfg, db, req.storyId, req.message, agent, req.roles === true);
      for await (const ev of gen) {
        if (ev.type === "agent_delta") {
          outputs.set(agent, (outputs.get(agent) ?? "") + ev.text);
        }
        push({ agent, ev });
      }
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

  // Writers'-room merge: Claude synthesizes a final version from the three role
  // outputs — the draft, the continuity constraints, and the structural notes.
  if (req.roles && req.synthesize && outputs.size > 0) {
    yield { type: "synthesis_start" };
    const sections = agents
      .map((a) => {
        const out = outputs.get(a);
        if (!out) return "";
        return `=== ${ENSEMBLE_ROLES[a].role.toUpperCase()} (${a}) ===\n${out}`;
      })
      .filter(Boolean)
      .join("\n\n");
    const systemPrompt =
      "You are the showrunner of a writers' room. You are given a DRAFTER's prose, a " +
      "CONTINUITY editor's constraints/issues, and a STORY ARCHITECT's structural notes. " +
      "Produce the best FINAL version of what the request asked for: keep the drafter's prose as " +
      "the base, fix every continuity issue raised, and fold in the strongest structural suggestions. " +
      "Output ONLY the final result — prose if the request was to write, otherwise a tight merged plan. " +
      "No commentary about the process, no fences.";
    const recorder = makeRecorder(db, "claude", req.storyId);
    try {
      for await (const chunk of claudeStream(
        `ORIGINAL REQUEST:\n${req.message}\n\n${sections}`,
        {
          systemPrompt,
          cwd: cfg.VAULT_PATH,
          skipMcp: true,
          onUsage: (u) =>
            recorder({
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              cachedInputTokens: u.cachedInputTokens,
              model: u.model,
            }),
        }
      )) {
        yield { type: "synthesis_delta", text: chunk };
      }
    } catch (e) {
      yield { type: "synthesis_delta", text: `\n\n[synthesis error: ${e instanceof Error ? e.message : String(e)}]` };
    }
    yield { type: "synthesis_done" };
  }

  yield { type: "all_done" };
}
