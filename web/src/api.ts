// API client. Reads bearer token from localStorage.

export type SearchMode = "lore" | "style" | "uncensored" | "any";
export type SearchHit = {
  chunkId: number;
  filePath: string;
  headingPath: string | null;
  startLine: number;
  endLine: number;
  tags: string;
  content: string;
  vectorDistance: number;
  rerankScore?: number;
};
export type Stats = { files: number; chunks: number; vec_rows: number };
export type StyleProfile = { name: string; path: string; bytes: number };
export type ComposedStyle = {
  base: { name: string; path: string };
  genres: { name: string; path: string }[];
  content: string;
};
export type ReindexResult = {
  filesScanned: number;
  filesChanged: number;
  filesDeleted: number;
  chunksWritten: number;
  tokensEmbedded: number;
};

export type DiscoveredStory = { path: string; name: string; series: string };
export type Story = {
  id: number;
  path: string;
  name: string;
  series: string | null;
  active_style: string | null;
  active_genres: string[];
  created_at: number;
  updated_at: number;
};
export type ChatMessage = {
  id: number;
  story_id: number;
  role: "user" | "assistant" | "system";
  agent: string | null;
  content: string;
  context_used: unknown | null;
  created_at: number;
};
export type AgentName = "claude" | "codex" | "gemini";
export type AgentSelection = AgentName | "auto";

const TOKEN_KEY = "quill.token";

export const auth = {
  get(): string {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  },
  set(t: string): void {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  },
};

async function req<T>(
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const t = auth.get();
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? "GET",
    headers,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => req<{ ok: boolean }>("/health"),
  stats: () => req<Stats>("/stats"),
  search: (
    query: string,
    mode: SearchMode = "lore",
    topK = 8,
    candidates = 40,
    useRerank = true
  ) =>
    req<{ hits: SearchHit[] }>("/search", {
      method: "POST",
      body: { query, mode, topK, candidates, useRerank },
    }),
  reindex: (full = false) =>
    req<ReindexResult>("/reindex", { method: "POST", body: { full } }),
  styleList: () => req<{ styles: StyleProfile[] }>("/style/list"),
  styleGet: (name: string) =>
    req<{ name: string; path: string; content: string }>(
      `/style/get/${encodeURIComponent(name)}`
    ),
  genreList: () => req<{ genres: StyleProfile[] }>("/genre/list"),
  genreGet: (name: string) =>
    req<{ name: string; path: string; content: string }>(
      `/genre/get/${encodeURIComponent(name)}`
    ),
  styleCompose: (base: string, genres: string[]) =>
    req<ComposedStyle>("/style/compose", {
      method: "POST",
      body: { base, genres },
    }),
  storiesDiscover: () => req<{ stories: DiscoveredStory[] }>("/stories/discover"),
  storiesList: () => req<{ stories: Story[] }>("/stories"),
  storyCreate: (s: DiscoveredStory) =>
    req<Story>("/stories", { method: "POST", body: s }),
  storyGet: (id: number) => req<Story>(`/stories/${id}`),
  storyPatch: (
    id: number,
    patch: { active_style?: string | null; active_genres?: string[] }
  ) => req<Story>(`/stories/${id}`, { method: "PATCH", body: patch }),
  storyDelete: (id: number) =>
    req<{ ok: boolean }>(`/stories/${id}`, { method: "DELETE" }),
  storyMessages: (id: number) =>
    req<{ messages: ChatMessage[] }>(`/stories/${id}/messages`),
  storyClearMessages: (id: number) =>
    req<{ removed: number }>(`/stories/${id}/messages`, { method: "DELETE" }),
  workflowList: () => req<{ workflows: WorkflowDef[] }>("/workflows"),
  vaultTree: () => req<TreeNode>("/vault/tree"),
  vaultFile: (path: string) =>
    req<VaultFile>(`/vault/file?path=${encodeURIComponent(path)}`),
  vaultResolve: (target: string) =>
    req<{ target: string; path: string | null }>(
      `/vault/resolve?target=${encodeURIComponent(target)}`
    ),
  loreEntities: () => req<{ entities: Entity[] }>("/lore/entities"),
  draftsList: (path?: string) =>
    req<{ drafts: DraftMeta[] }>(
      path ? `/drafts?path=${encodeURIComponent(path)}` : "/drafts"
    ),
  draftCreate: (filePath: string, note?: string) =>
    req<DraftMeta>("/drafts", { method: "POST", body: { filePath, note } }),
  draftGet: (id: number) => req<DraftFull>(`/drafts/${id}`),
  draftDelete: (id: number) =>
    req<{ ok: boolean }>(`/drafts/${id}`, { method: "DELETE" }),
  usage: (storyId?: number, since?: number) => {
    const qs = new URLSearchParams();
    if (storyId != null) qs.set("storyId", String(storyId));
    if (since != null) qs.set("since", String(since));
    const tail = qs.toString();
    return req<UsageResponse>(`/usage${tail ? "?" + tail : ""}`);
  },
  usageTotals: () => req<UsageTotals>("/usage/totals"),
};

export type UsageEvent = {
  id: number;
  ts: number;
  storyId: number | null;
  agent: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  meta: Record<string, unknown> | null;
};
export type UsageRollupRow = {
  agent: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  costUsd: number;
  events: number;
};
export type UsageResponse = {
  events: UsageEvent[];
  totals: UsageRollupRow[];
  summary: { tokens: number; costUsd: number; events: number };
};
export type UsageTotals = {
  perAgent: UsageRollupRow[];
  perDay: { day: string; tokens: number; costUsd: number }[];
  perStory: { storyId: number | null; tokens: number; costUsd: number }[];
  totals: { tokens: number; costUsd: number; events: number };
};

export type TreeNode = {
  name: string;
  path: string;
  kind: "dir" | "file";
  size?: number;
  mtime?: number;
  children?: TreeNode[];
};
export type VaultFile = {
  path: string;
  bytes: number;
  mtime: number;
  content: string;
  frontmatter: Record<string, unknown> | null;
};
export type Entity = {
  name: string;
  occurrences: number;
  files: { path: string; count: number }[];
};
export type DraftMeta = {
  id: number;
  file_path: string;
  note: string | null;
  hash: string;
  bytes: number;
  created_at: number;
};
export type DraftFull = DraftMeta & { content: string };

export type WorkflowField = {
  name: string;
  label: string;
  kind: "text" | "textarea" | "number" | "select";
  required?: boolean;
  default?: string | number;
  placeholder?: string;
  options?: { value: string; label: string }[];
  rows?: number;
};
export type WorkflowDef = {
  id: string;
  title: string;
  description: string;
  agent: AgentName;
  fields: WorkflowField[];
};

/**
 * SSE chat stream. Yields parsed events.
 * Caller is responsible for awaiting the generator and stopping via `controller`.
 */
async function openSse(
  url: string,
  body: unknown
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const t = auth.get();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok || !res.body) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.body.getReader();
}

async function* parseSse(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<{ event: string; data: unknown }, void, void> {
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const lines = block.split("\n");
      let event = "message";
      let dataStr = "";
      for (const ln of lines) {
        if (ln.startsWith("event:")) event = ln.slice(6).trim();
        else if (ln.startsWith("data:")) dataStr += ln.slice(5).trim();
      }
      if (!dataStr) continue;
      try {
        yield { event, data: JSON.parse(dataStr) };
      } catch {
        yield { event, data: dataStr };
      }
    }
  }
}

export async function* chatStream(
  storyId: number,
  message: string,
  agent: AgentSelection
): AsyncGenerator<{ event: string; data: unknown }, void, void> {
  const reader = await openSse(`/api/stories/${storyId}/chat`, { message, agent });
  yield* parseSse(reader);
}

export async function* workflowStream(
  storyId: number,
  workflowId: string,
  inputs: Record<string, string>
): AsyncGenerator<{ event: string; data: unknown }, void, void> {
  const reader = await openSse(`/api/stories/${storyId}/workflow`, {
    workflowId,
    inputs,
  });
  yield* parseSse(reader);
}

export type RegenerateOpts = {
  fromMessageId: number;
  agent: AgentSelection;
  editedContent?: string;
};

export async function* regenerateStream(
  storyId: number,
  opts: RegenerateOpts
): AsyncGenerator<{ event: string; data: unknown }, void, void> {
  const reader = await openSse(`/api/stories/${storyId}/regenerate`, opts);
  yield* parseSse(reader);
}

