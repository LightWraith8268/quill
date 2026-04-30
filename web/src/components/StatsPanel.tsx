import { useEffect, useState } from "react";
import { api, auth, type ReindexResult, type Stats } from "../api.ts";
import { WordCountDashboard } from "./WordCountDashboard.tsx";

type ProbeResult = { ok: boolean; latencyMs: number; error?: string };
type DbProbe = { ok: boolean; sizeBytes: number; error?: string };
type VaultProbe = { ok: boolean; path: string; fileCount: number; error?: string };
type HealthReport = {
  voyage: ProbeResult;
  claude: ProbeResult;
  codex: ProbeResult;
  gemini: ProbeResult;
  db: DbProbe;
  vault: VaultProbe;
};
type ErrEvent = {
  ts: number;
  source: string;
  message: string;
  stack?: string;
  meta?: unknown;
};

async function authFetch<T>(path: string): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const t = auth.get();
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(`/api${path}`, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

export function StatsPanel({ activeStoryId }: { activeStoryId: number | null }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [last, setLast] = useState<ReindexResult | null>(null);

  const refresh = () => {
    api.stats().then(setStats).catch((e: Error) => setErr(e.message));
  };

  useEffect(refresh, []);

  const reindex = async (full: boolean) => {
    if (
      full &&
      !confirm("Full reindex re-embeds every chunk. May take a while + use tokens. Continue?")
    )
      return;
    setReindexing(true);
    setErr(null);
    try {
      const r = await api.reindex(full);
      setLast(r);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setReindexing(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="card">
        <h2 className="font-display text-2xl mb-4">Vault Stats</h2>
        {stats ? (
          <div className="grid grid-cols-3 gap-4 text-center">
            <Stat label="Files" value={stats.files} />
            <Stat label="Chunks" value={stats.chunks} />
            <Stat label="Vectors" value={stats.vec_rows} />
          </div>
        ) : (
          <p className="text-muted text-sm">Loading…</p>
        )}
      </div>

      <div className="card space-y-3">
        <h3 className="font-display text-lg">Reindex</h3>
        <p className="text-sm text-muted">
          Incremental reindex walks the vault and only re-embeds changed files
          (mtime + hash diff). Full reindex rebuilds everything.
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => reindex(false)}
            disabled={reindexing}
            className="btn btn-primary"
          >
            {reindexing ? "Working…" : "Reindex (incremental)"}
          </button>
          <button
            onClick={() => reindex(true)}
            disabled={reindexing}
            className="btn btn-ghost"
          >
            Full rebuild
          </button>
        </div>
        {last && (
          <div className="text-sm font-mono bg-paper/40 border border-bg/10 dark:bg-bg/60 dark:border-muted/20 rounded p-3">
            <div>files scanned: {last.filesScanned}</div>
            <div>changed: {last.filesChanged}</div>
            <div>deleted: {last.filesDeleted}</div>
            <div>chunks written: {last.chunksWritten}</div>
            <div>tokens embedded: {last.tokensEmbedded.toLocaleString()}</div>
          </div>
        )}
      </div>

      <HealthCard />
      <ErrorsCard />

      {activeStoryId !== null && (
        <WordCountDashboard storyId={activeStoryId} />
      )}

      {err && <div className="bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200 text-sm p-3 rounded">{err}</div>}
    </div>
  );
}

function Stat(props: { label: string; value: number }) {
  return (
    <div>
      <div className="font-display text-3xl text-tealBright">
        {props.value.toLocaleString()}
      </div>
      <div className="text-xs text-muted uppercase tracking-wide">{props.label}</div>
    </div>
  );
}

function HealthCard() {
  const [open, setOpen] = useState(true);
  const [report, setReport] = useState<HealthReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await authFetch<HealthReport>("/health/full");
      setReport(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <button
          onClick={() => setOpen((o) => !o)}
          className="font-display text-lg hover:opacity-80"
        >
          {open ? "▾" : "▸"} Health
        </button>
        <button onClick={refresh} disabled={loading} className="btn btn-ghost text-sm">
          {loading ? "Checking…" : "Refresh"}
        </button>
      </div>
      {open && (
        <div className="space-y-2">
          {err && <div className="text-sm text-red-700 dark:text-red-300">{err}</div>}
          {report ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <ProbeBadge name="Voyage" probe={report.voyage} />
              <ProbeBadge name="Claude CLI" probe={report.claude} />
              <ProbeBadge name="Codex CLI" probe={report.codex} />
              <ProbeBadge name="Gemini CLI" probe={report.gemini} />
              <DbBadge probe={report.db} />
              <VaultBadge probe={report.vault} />
            </div>
          ) : !err ? (
            <p className="text-muted text-sm">Loading…</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

function statusClass(state: "ok" | "err" | "unknown"): string {
  if (state === "ok") return "bg-green-100 text-green-900 dark:bg-green-900/40 dark:text-green-200";
  if (state === "err") return "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200";
  return "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200";
}

function ProbeBadge({ name, probe }: { name: string; probe: ProbeResult }) {
  const state: "ok" | "err" | "unknown" = probe.ok ? "ok" : "err";
  return (
    <div className={`rounded p-2 text-sm ${statusClass(state)}`}>
      <div className="flex items-center justify-between">
        <span className="font-medium">{name}</span>
        <span className="font-mono text-xs">
          {probe.ok ? `${probe.latencyMs}ms` : "fail"}
        </span>
      </div>
      {probe.error && (
        <div className="text-xs mt-1 break-words font-mono opacity-80">{probe.error}</div>
      )}
    </div>
  );
}

function DbBadge({ probe }: { probe: DbProbe }) {
  const state: "ok" | "err" = probe.ok ? "ok" : "err";
  return (
    <div className={`rounded p-2 text-sm ${statusClass(state)}`}>
      <div className="flex items-center justify-between">
        <span className="font-medium">DB</span>
        <span className="font-mono text-xs">
          {probe.ok ? formatBytes(probe.sizeBytes) : "fail"}
        </span>
      </div>
      {probe.error && (
        <div className="text-xs mt-1 break-words font-mono opacity-80">{probe.error}</div>
      )}
    </div>
  );
}

function VaultBadge({ probe }: { probe: VaultProbe }) {
  const state: "ok" | "err" = probe.ok ? "ok" : "err";
  return (
    <div className={`rounded p-2 text-sm ${statusClass(state)}`}>
      <div className="flex items-center justify-between">
        <span className="font-medium">Vault</span>
        <span className="font-mono text-xs">
          {probe.ok ? `${probe.fileCount} md` : "fail"}
        </span>
      </div>
      <div className="text-xs mt-1 break-words font-mono opacity-70">{probe.path}</div>
      {probe.error && (
        <div className="text-xs mt-1 break-words font-mono opacity-80">{probe.error}</div>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function ErrorsCard() {
  const [open, setOpen] = useState(false);
  const [errors, setErrors] = useState<ErrEvent[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await authFetch<{ errors: ErrEvent[] }>("/errors?limit=20");
      setErrors(r.errors);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && !errors) refresh();
  }, [open]);

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <button
          onClick={() => setOpen((o) => !o)}
          className="font-display text-lg hover:opacity-80"
        >
          {open ? "▾" : "▸"} Recent errors
        </button>
        {open && (
          <button onClick={refresh} disabled={loading} className="btn btn-ghost text-sm">
            {loading ? "Loading…" : "Refresh"}
          </button>
        )}
      </div>
      {open && (
        <div className="space-y-1">
          {err && <div className="text-sm text-red-700 dark:text-red-300">{err}</div>}
          {errors && errors.length === 0 && (
            <p className="text-muted text-sm">No errors logged.</p>
          )}
          {errors?.map((e, i) => {
            const firstLine = e.message.split("\n")[0];
            const ts = new Date(e.ts).toLocaleString();
            return (
              <details
                key={i}
                className="text-sm border border-bg/10 dark:border-muted/20 rounded p-2"
              >
                <summary className="cursor-pointer">
                  <span className="font-mono text-xs text-muted">{ts}</span>{" "}
                  <span className="font-medium">[{e.source}]</span>{" "}
                  <span className="break-words">{firstLine}</span>
                </summary>
                {e.stack && (
                  <pre className="mt-2 text-xs whitespace-pre-wrap font-mono opacity-80">
                    {e.stack}
                  </pre>
                )}
                {e.meta !== undefined && e.meta !== null && (
                  <pre className="mt-2 text-xs whitespace-pre-wrap font-mono opacity-80">
                    {JSON.stringify(e.meta, null, 2)}
                  </pre>
                )}
              </details>
            );
          })}
          {!errors && !err && <p className="text-muted text-sm">Loading…</p>}
        </div>
      )}
    </div>
  );
}
