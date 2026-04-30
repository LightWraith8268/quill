// Token usage + approximate cost tracking.
//
// IMPORTANT: CLI agents (Claude Code, Codex, Gemini) typically run under the
// user's existing subscriptions / API keys configured in those CLIs. The
// "cost" computed here is an approximate retail-rate ESTIMATE for visibility,
// not a billable figure. Voyage embed/rerank is billed directly by API key.

import type { DB } from "./db.ts";

export type UsageAgent =
  | "claude"
  | "codex"
  | "gemini"
  | "voyage_embed"
  | "voyage_rerank";

export type UsageEvent = {
  id?: number;
  ts: number;
  storyId: number | null;
  agent: UsageAgent;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  meta?: Record<string, unknown> | null;
};

// Rates: USD per million tokens. (input / output / cached_input).
// Embedding/rerank: input only, output cost is 0.
type RateRow = { in: number; out: number; cached: number };

const RATES: Record<string, RateRow> = {
  // Voyage
  "voyage-4-lite": { in: 0.02, out: 0, cached: 0 },
  "rerank-2.5-lite": { in: 0.02, out: 0, cached: 0 },
  // Claude (approximate retail; Claude Code subscription may differ)
  "claude-sonnet-4.6": { in: 3.0, out: 15.0, cached: 0.3 },
  "claude-opus-4.7": { in: 15.0, out: 75.0, cached: 1.5 },
  // Codex / GPT-5 estimate
  "gpt-5": { in: 1.25, out: 10.0, cached: 0 },
  // Gemini estimate
  "gemini-2.5-pro": { in: 1.25, out: 10.0, cached: 0 },
};

const DEFAULT_MODEL: Record<UsageAgent, string> = {
  claude: "claude-sonnet-4.6",
  codex: "gpt-5",
  gemini: "gemini-2.5-pro",
  voyage_embed: "voyage-4-lite",
  voyage_rerank: "rerank-2.5-lite",
};

export function estimateCostUsd(
  agent: UsageAgent,
  model: string | null,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number
): number {
  const key = model && RATES[model] ? model : DEFAULT_MODEL[agent];
  const r = RATES[key] ?? { in: 0, out: 0, cached: 0 };
  // Treat cached_input_tokens as a SUBSET of input_tokens for billing terms.
  // Some providers report it as additional; we prefer the safe over-estimate.
  const billedInput = Math.max(0, inputTokens - cachedInputTokens);
  const cost =
    (billedInput * r.in) / 1e6 +
    (cachedInputTokens * r.cached) / 1e6 +
    (outputTokens * r.out) / 1e6;
  return cost;
}

export function recordUsage(db: DB, ev: Omit<UsageEvent, "id" | "costUsd"> & { costUsd?: number }): UsageEvent {
  const cost =
    ev.costUsd ??
    estimateCostUsd(
      ev.agent,
      ev.model,
      ev.inputTokens,
      ev.outputTokens,
      ev.cachedInputTokens
    );
  const stmt = db.prepare(`
    INSERT INTO usage_events
      (ts, story_id, agent, model, input_tokens, output_tokens, cached_input_tokens, cost_usd, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    ev.ts,
    ev.storyId,
    ev.agent,
    ev.model,
    ev.inputTokens,
    ev.outputTokens,
    ev.cachedInputTokens,
    cost,
    ev.meta ? JSON.stringify(ev.meta) : null
  );
  return { ...ev, id: Number(info.lastInsertRowid), costUsd: cost };
}

export type RollupRow = {
  agent: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  costUsd: number;
  events: number;
};

export type RollupOptions = {
  storyId?: number | null;
  since?: number; // ms epoch
  agent?: UsageAgent;
};

type DbRow = {
  id: number;
  ts: number;
  story_id: number | null;
  agent: string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cost_usd: number;
  meta: string | null;
};

function rowToEvent(r: DbRow): UsageEvent {
  return {
    id: r.id,
    ts: r.ts,
    storyId: r.story_id,
    agent: r.agent as UsageAgent,
    model: r.model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cachedInputTokens: r.cached_input_tokens,
    costUsd: r.cost_usd,
    meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : null,
  };
}

export function listUsageEvents(db: DB, opts: RollupOptions = {}): UsageEvent[] {
  const where: string[] = [];
  const params: (number | string)[] = [];
  if (opts.storyId != null) {
    where.push("story_id = ?");
    params.push(opts.storyId);
  }
  if (opts.since != null) {
    where.push("ts >= ?");
    params.push(opts.since);
  }
  if (opts.agent) {
    where.push("agent = ?");
    params.push(opts.agent);
  }
  const sql = `
    SELECT * FROM usage_events
    ${where.length > 0 ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY ts DESC
    LIMIT 500
  `;
  const rows = db.query<DbRow, typeof params>(sql).all(...params);
  return rows.map(rowToEvent);
}

export function usageRollup(
  db: DB,
  opts: RollupOptions = {}
): {
  perAgent: RollupRow[];
  perDay: { day: string; tokens: number; costUsd: number }[];
  perStory: { storyId: number | null; tokens: number; costUsd: number }[];
  totals: { tokens: number; costUsd: number; events: number };
} {
  const where: string[] = [];
  const params: (number | string)[] = [];
  if (opts.storyId != null) {
    where.push("story_id = ?");
    params.push(opts.storyId);
  }
  if (opts.since != null) {
    where.push("ts >= ?");
    params.push(opts.since);
  }
  const whereSql = where.length > 0 ? "WHERE " + where.join(" AND ") : "";

  const perAgent = db
    .query<
      {
        agent: string;
        in_tok: number;
        out_tok: number;
        cached_tok: number;
        cost: number;
        n: number;
      },
      typeof params
    >(
      `SELECT agent,
              COALESCE(SUM(input_tokens),0) AS in_tok,
              COALESCE(SUM(output_tokens),0) AS out_tok,
              COALESCE(SUM(cached_input_tokens),0) AS cached_tok,
              COALESCE(SUM(cost_usd),0) AS cost,
              COUNT(*) AS n
       FROM usage_events ${whereSql}
       GROUP BY agent
       ORDER BY cost DESC`
    )
    .all(...params)
    .map(
      (r): RollupRow => ({
        agent: r.agent,
        inputTokens: r.in_tok,
        outputTokens: r.out_tok,
        cachedInputTokens: r.cached_tok,
        totalTokens: r.in_tok + r.out_tok,
        costUsd: r.cost,
        events: r.n,
      })
    );

  const perDay = db
    .query<{ day: string; tokens: number; cost: number }, typeof params>(
      `SELECT date(ts/1000, 'unixepoch') AS day,
              COALESCE(SUM(input_tokens + output_tokens),0) AS tokens,
              COALESCE(SUM(cost_usd),0) AS cost
       FROM usage_events ${whereSql}
       GROUP BY day
       ORDER BY day DESC
       LIMIT 30`
    )
    .all(...params)
    .map((r) => ({ day: r.day, tokens: r.tokens, costUsd: r.cost }));

  const perStory = db
    .query<
      { story_id: number | null; tokens: number; cost: number },
      typeof params
    >(
      `SELECT story_id,
              COALESCE(SUM(input_tokens + output_tokens),0) AS tokens,
              COALESCE(SUM(cost_usd),0) AS cost
       FROM usage_events ${whereSql}
       GROUP BY story_id
       ORDER BY cost DESC`
    )
    .all(...params)
    .map((r) => ({ storyId: r.story_id, tokens: r.tokens, costUsd: r.cost }));

  const totals = perAgent.reduce(
    (acc, r) => ({
      tokens: acc.tokens + r.totalTokens,
      costUsd: acc.costUsd + r.costUsd,
      events: acc.events + r.events,
    }),
    { tokens: 0, costUsd: 0, events: 0 }
  );

  return { perAgent, perDay, perStory, totals };
}

export type UsageRecorder = (u: {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  model?: string | null;
}) => void;

export function makeRecorder(
  db: DB,
  agent: UsageAgent,
  storyId: number | null,
  defaultModel?: string
): UsageRecorder {
  return (u) => {
    recordUsage(db, {
      ts: Date.now(),
      storyId,
      agent,
      model: u.model ?? defaultModel ?? null,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cachedInputTokens: u.cachedInputTokens ?? 0,
    });
  };
}
