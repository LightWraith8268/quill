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
  active_scene_path: string | null;
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
  openWorkspace: (path: string) =>
    req<{ story: Story; scope: { series: string | null; book: string | null } }>(
      "/workspace/open",
      { method: "POST", body: { path } }
    ),
  storyGet: (id: number) => req<Story>(`/stories/${id}`),
  storyPatch: (
    id: number,
    patch: {
      active_style?: string | null;
      active_genres?: string[];
      active_scene_path?: string | null;
    }
  ) => req<Story>(`/stories/${id}`, { method: "PATCH", body: patch }),
  charactersList: () =>
    req<{ series: { series: string; characterCount: number }[] }>("/characters"),
  charactersForSeries: (series: string) =>
    req<{ series: string; characters: CharacterDef[] }>(
      `/characters/${encodeURIComponent(series)}`
    ),
  voiceCheck: (text: string, seriesPath?: string) =>
    req<VoiceCheckResult>("/voice/check", {
      method: "POST",
      body: { text, seriesPath },
    }),
  outlineList: (storyId: number) =>
    req<{ nodes: OutlineNode[] }>(`/stories/${storyId}/outline`),
  outlineCreate: (
    storyId: number,
    body: {
      parentId?: number | null;
      kind: "act" | "chapter" | "scene" | "note";
      title: string;
      summary?: string;
      targetWords?: number;
      manuscriptPath?: string;
    }
  ) =>
    req<OutlineNode>(`/stories/${storyId}/outline`, {
      method: "POST",
      body,
    }),
  outlineUpdate: (
    nodeId: number,
    patch: Partial<{
      title: string;
      summary: string | null;
      target_words: number | null;
      status: "outlined" | "drafted" | "revised" | "locked";
      manuscript_path: string | null;
      parent_id: number | null;
      sort_order: number;
    }>
  ) => req<OutlineNode>(`/outline/${nodeId}`, { method: "PATCH", body: patch }),
  outlineDelete: (nodeId: number) =>
    req<{ ok: boolean }>(`/outline/${nodeId}`, { method: "DELETE" }),
  outlineReorder: (
    storyId: number,
    parentId: number | null,
    orderedIds: number[]
  ) =>
    req<{ ok: boolean }>(`/stories/${storyId}/outline/reorder`, {
      method: "POST",
      body: { parentId, orderedIds },
    }),
  readingPass: (storyId: number) =>
    req<ReadingPass>(`/stories/${storyId}/reading`),
  clipUrl: (url: string, topic?: string) =>
    req<{ url: string; title: string; vaultPath: string; bytes: number; textLength: number }>(
      "/research/clip",
      { method: "POST", body: { url, topic } }
    ),
  storyGlossary: (storyId: number) =>
    req<{
      story: { id: number; name: string; series: string | null };
      entries: { term: string; source: string; count?: number; files?: string[] }[];
    }>(`/stories/${storyId}/glossary`),
  branchStory: (storyId: number, label: string) =>
    req<{ storyId: number; branchOf: number; label: string }>(
      `/stories/${storyId}/branch`,
      { method: "POST", body: { label } }
    ),
  goalsList: (storyId: number) =>
    req<{ goals: GoalRow[] }>(`/stories/${storyId}/goals`),
  goalUpsert: (
    storyId: number,
    body: {
      kind: "daily_words" | "total_words" | "deadline";
      target?: number | null;
      deadline_ms?: number | null;
    }
  ) => req<GoalRow>(`/stories/${storyId}/goals`, { method: "POST", body }),
  goalDelete: (id: number) =>
    req<{ ok: boolean }>(`/goals/${id}`, { method: "DELETE" }),
  sessionStart: (storyId: number, filePath?: string) =>
    req<TimeSessionRow>(`/stories/${storyId}/sessions/start`, {
      method: "POST",
      body: { filePath },
    }),
  sessionHeartbeat: (sessionId: number) =>
    req<TimeSessionRow>("/sessions/heartbeat", {
      method: "POST",
      body: { sessionId },
    }),
  sessionEnd: (sessionId: number) =>
    req<TimeSessionRow>("/sessions/end", {
      method: "POST",
      body: { sessionId },
    }),
  sessionsList: (storyId: number, days = 30) =>
    req<{ sessions: TimeSessionRow[] }>(
      `/stories/${storyId}/sessions?days=${days}`
    ),
  daylogPost: (storyId: number, day: string, wordsAtEnd: number) =>
    req<DailyWordRow>(`/stories/${storyId}/daylog`, {
      method: "POST",
      body: { day, wordsAtEnd },
    }),
  daylogList: (storyId: number, days = 30) =>
    req<{ days: DailyWordRow[] }>(
      `/stories/${storyId}/daylog?days=${days}`
    ),
  storyBeats: (storyId: number) =>
    req<{ chapters: ChapterBeats[] }>(`/stories/${storyId}/beats`),
  kbContinuity: (storyId: number, file: string, useLlm = true) =>
    req<{ issues: ContinuityIssue[] }>(
      `/stories/${storyId}/kb/continuity?file=${encodeURIComponent(file)}&llm=${useLlm}`
    ),
  kbStats: (storyId: number) =>
    req<{ entities: number; facts: number }>(`/stories/${storyId}/kb/stats`),
  kbSearch: (storyId: number, q: string, facts = 12, chunks = 6) =>
    req<{ items: CanonItem[] }>(
      `/stories/${storyId}/kb/search?q=${encodeURIComponent(q)}&facts=${facts}&chunks=${chunks}`
    ),
  kbExtract: (storyId: number) =>
    req<Record<string, unknown>>(`/stories/${storyId}/kb/extract`, { method: "POST" }),
  kbBeats: (storyId: number, template = "save-the-cat") =>
    req<BeatAlignment>(
      `/stories/${storyId}/kb/beats?template=${encodeURIComponent(template)}`
    ),
  kbPacing: (storyId: number) =>
    req<PacingReport>(`/stories/${storyId}/kb/pacing`),
  pronunciationGet: () => req<Record<string, string>>("/pronunciation"),
  pronunciationSet: (map: Record<string, string>) =>
    req<{ ok: boolean }>("/pronunciation", { method: "PUT", body: map }),
  seriesRenamePreview: (
    series: string,
    needle: string,
    replacement: string,
    wholeWord = true
  ) =>
    req<{
      series: string;
      needle: string;
      replacement: string;
      matches: { path: string; line: number; col: number; context: string }[];
      fileCount: number;
    }>("/series/rename", {
      method: "POST",
      body: { series, needle, replacement, wholeWord, apply: false },
    }),
  seriesRenameApply: (
    series: string,
    needle: string,
    replacement: string,
    wholeWord = true
  ) =>
    req<{ apply: true; filesTouched: number; totalReplacements: number }>(
      "/series/rename",
      {
        method: "POST",
        body: { series, needle, replacement, wholeWord, apply: true },
      }
    ),
  calendarUrl: (storyId: number): string =>
    `/api/stories/${storyId}/calendar.ics`,
  inspirationsList: (storyId: number) =>
    req<{ inspirations: Inspiration[] }>(`/stories/${storyId}/inspirations`),
  inspirationAdd: (
    storyId: number,
    body: { kind: "image" | "quote" | "link" | "note"; url?: string; content?: string; caption?: string }
  ) => req<Inspiration>(`/stories/${storyId}/inspirations`, { method: "POST", body }),
  inspirationDelete: (id: number) =>
    req<{ ok: boolean }>(`/inspirations/${id}`, { method: "DELETE" }),
  submissionsList: (storyId: number) =>
    req<{ submissions: Submission[] }>(`/stories/${storyId}/submissions`),
  submissionCreate: (storyId: number, body: { agent: string; agency?: string; notes?: string }) =>
    req<Submission>(`/stories/${storyId}/submissions`, { method: "POST", body }),
  submissionUpdate: (id: number, patch: Partial<Submission>) =>
    req<Submission>(`/submissions/${id}`, { method: "PATCH", body: patch }),
  submissionDelete: (id: number) =>
    req<{ ok: boolean }>(`/submissions/${id}`, { method: "DELETE" }),
  shareLinksList: () => req<{ links: ShareLink[] }>("/share-links"),
  shareLinkCreate: (body: { filePath: string; label?: string; expiresAtMs?: number | null }) =>
    req<ShareLink>("/share-links", { method: "POST", body }),
  shareLinkDelete: (id: number) =>
    req<{ ok: boolean }>(`/share-links/${id}`, { method: "DELETE" }),
  compileStory: async (
    storyId: number,
    format: "md" | "html" | "docx"
  ): Promise<{ filename: string; bytes: number }> => {
    const t = auth.get();
    const headers: Record<string, string> = {};
    if (t) headers.Authorization = `Bearer ${t}`;
    const res = await fetch(
      `/api/stories/${storyId}/compile?format=${format}`,
      { headers }
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status}: ${text}`);
    }
    const cd = res.headers.get("Content-Disposition") ?? "";
    const m = cd.match(/filename="?([^"]+)"?/);
    const filename = m?.[1] ?? `compiled.${format}`;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return { filename, bytes: blob.size };
  },
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
  vaultWrite: (path: string, content: string, snapshotNote?: string) =>
    req<VaultWriteResult>("/vault/write", {
      method: "POST",
      body: { path, content, snapshotNote },
    }),
  vaultInsert: (
    path: string,
    text: string,
    mode: "append" | "prepend" | "at-line",
    line?: number,
    snapshotNote?: string
  ) =>
    req<VaultWriteResult>("/vault/insert", {
      method: "POST",
      body: { path, text, mode, line, snapshotNote },
    }),
  draftsList: (path?: string) =>
    req<{ drafts: DraftMeta[] }>(
      path ? `/drafts?path=${encodeURIComponent(path)}` : "/drafts"
    ),
  draftCreate: (filePath: string, note?: string) =>
    req<DraftMeta>("/drafts", { method: "POST", body: { filePath, note } }),
  draftGet: (id: number) => req<DraftFull>(`/drafts/${id}`),
  draftDelete: (id: number) =>
    req<{ ok: boolean }>(`/drafts/${id}`, { method: "DELETE" }),
  storyWordCount: (id: number) =>
    req<StoryWordCount>(`/stories/${id}/wordcount`),
  usage: (storyId?: number, since?: number) => {
    const qs = new URLSearchParams();
    if (storyId != null) qs.set("storyId", String(storyId));
    if (since != null) qs.set("since", String(since));
    const tail = qs.toString();
    return req<UsageResponse>(`/usage${tail ? "?" + tail : ""}`);
  },
  usageTotals: () => req<UsageTotals>("/usage/totals"),
  exportStory: async (storyId: number): Promise<{ filename: string; bytes: number }> => {
    const t = auth.get();
    const headers: Record<string, string> = {};
    if (t) headers.Authorization = `Bearer ${t}`;
    const res = await fetch(`/api/stories/${storyId}/export`, { headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status}: ${text}`);
    }
    // Try to parse filename from Content-Disposition; fall back to a default.
    let filename = `story-${storyId}.json`;
    const disp = res.headers.get("Content-Disposition") ?? "";
    const m = disp.match(/filename="?([^"]+)"?/i);
    if (m && m[1]) filename = m[1];
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Defer revoke so download has time to start in all browsers.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { filename, bytes: blob.size };
  },
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

export type GoalRow = {
  id: number;
  story_id: number;
  kind: "daily_words" | "total_words" | "deadline";
  target: number | null;
  deadline_ms: number | null;
  created_at: number;
  updated_at: number;
};
export type TimeSessionRow = {
  id: number;
  story_id: number;
  started_at: number;
  ended_at: number | null;
  seconds: number;
  file_path: string | null;
};
export type Inspiration = {
  id: number;
  story_id: number;
  kind: "image" | "quote" | "link" | "note";
  url: string | null;
  content: string | null;
  caption: string | null;
  created_at: number;
};
export type Submission = {
  id: number;
  story_id: number;
  agent: string;
  agency: string | null;
  sent_at: number | null;
  response_at: number | null;
  status: "queued" | "sent" | "partial" | "full" | "rejected" | "offer" | "withdrawn";
  notes: string | null;
  created_at: number;
  updated_at: number;
};
export type ShareLink = {
  id: number;
  token: string;
  file_path: string;
  label: string | null;
  expires_at: number | null;
  created_at: number;
};

export type ChapterBeats = {
  path: string;
  title: string;
  words: number;
  dialogueDensity: number;
  actionDensity: number;
  emphasisDensity: number;
  avgSentenceLen: number;
  sentenceVariance: number;
  intensity: number;
};

export type ContinuityIssue = {
  severity: "high" | "medium" | "low";
  entity: string | null;
  claim: string;
  canon: string;
  suggestion: string;
  source: "llm" | "heuristic";
};

export type CanonWeight =
  | "hard_canon"
  | "soft_canon"
  | "outline_plan"
  | "draft_text"
  | "note"
  | "rejected";
export type CanonItem = {
  kind: "fact" | "decision" | "timeline" | "summary" | "memory" | "chunk";
  entity: string | null;
  canonWeight: CanonWeight | null;
  title: string;
  text: string;
  sourcePath: string | null;
  sourceRef: string | null;
  score: number;
};

export type BeatStatus = "present" | "weak" | "missing";
export type BeatResult = {
  beat: string;
  status: BeatStatus;
  chapter: string | null;
  note: string;
};
export type BeatAlignment = {
  template: string;
  coverage: number;
  beats: BeatResult[];
};
export type PacingChapter = {
  title: string;
  path: string;
  words: number;
  z: number;
  outlier: boolean;
};
export type PacingReport = {
  mean: number;
  stdev: number;
  chapters: PacingChapter[];
  outliers: string[];
};

export type DailyWordRow = {
  id: number;
  story_id: number;
  day: string;
  words_at_start: number;
  words_at_end: number;
  delta: number;
  updated_at: number;
};

export type OutlineNode = {
  id: number;
  story_id: number;
  parent_id: number | null;
  sort_order: number;
  kind: "act" | "chapter" | "scene" | "note";
  title: string;
  summary: string | null;
  target_words: number | null;
  status: "outlined" | "drafted" | "revised" | "locked";
  manuscript_path: string | null;
  created_at: number;
  updated_at: number;
};
export type ReadingPart = {
  title: string;
  path: string;
  content: string;
  bytes: number;
  source: "outline" | "filesystem";
};
export type ReadingPass = {
  story: { id: number; name: string; path: string };
  parts: ReadingPart[];
  totalBytes: number;
};

export type VoiceCheckResult = {
  score: number;
  band: "drift" | "off-voice" | "matching" | "strong-match";
  centroidSampleSize: number;
  topSimilar: {
    path: string;
    headingPath: string | null;
    startLine: number;
    endLine: number;
    similarity: number;
    preview: string;
  }[];
};

export type CharacterDef = {
  name: string;
  role: string | null;
  tags: string[];
  voiceSummary: string | null;
  agePerBook: { book: string; age: string }[];
  coreDrives: string[];
  arc: { book: string; beats: string[] }[];
  relationships: { partner: string; description: string }[];
  writingTics: string[];
  sections: { heading: string; content: string }[];
};

export type WordCountSnapshot = {
  ts: number;
  words: number;
  bytes: number;
  note: string | null;
};
export type StoryWordCountFile = {
  path: string;
  currentWords: number;
  currentBytes: number;
  currentMtime: number;
  timeline: WordCountSnapshot[];
};
export type StoryWordCount = {
  story: { id: number; name: string; path: string };
  files: StoryWordCountFile[];
  totalWords: number;
};
export type VaultWriteResult = {
  ok: boolean;
  bytes: number;
  mtime: number;
  snapshotId?: number;
};

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
  outputSchema?: unknown;
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

export async function* ensembleStream(
  storyId: number,
  message: string,
  agents?: AgentName[]
): AsyncGenerator<{ event: string; data: unknown }, void, void> {
  const reader = await openSse(`/api/stories/${storyId}/ensemble`, {
    message,
    agents,
  });
  yield* parseSse(reader);
}

export async function* inlineEditStream(
  selection: string,
  instruction: string,
  storyId?: number
): AsyncGenerator<{ event: string; data: unknown }, void, void> {
  const reader = await openSse(`/api/edit/inline`, {
    selection,
    instruction,
    storyId,
  });
  yield* parseSse(reader);
}

export async function* inlineContinueStream(
  precedingText: string,
  storyId?: number,
  length?: "sentence" | "paragraph" | "scene"
): AsyncGenerator<{ event: string; data: unknown }, void, void> {
  const reader = await openSse(`/api/edit/continue`, {
    precedingText,
    storyId,
    length,
  });
  yield* parseSse(reader);
}

