// Subsystem health checks. Probe Voyage, agent CLIs, DB, vault.
// All checks are bounded by per-check timeouts plus an overall 5s race.

import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import type { Config } from "./config.ts";
import { openDb } from "./db.ts";
import { resolveBin } from "./agents/resolve.ts";
import { logError } from "./errlog.ts";

export type ProbeResult = { ok: boolean; latencyMs: number; error?: string };
export type EmbedProbe = ProbeResult & { provider: string; model: string };
export type DbProbe = { ok: boolean; sizeBytes: number; error?: string };
export type VaultProbe = {
  ok: boolean;
  path: string;
  fileCount: number;
  error?: string;
};

export type HealthReport = {
  embeddings: EmbedProbe;
  claude: ProbeResult;
  codex: ProbeResult;
  gemini: ProbeResult;
  db: DbProbe;
  vault: VaultProbe;
};

const OVERALL_TIMEOUT_MS = 5000;
const CLI_TIMEOUT_MS = 5000;
const HTTP_TIMEOUT_MS = 4000;

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// Probe the embedding backend: a local Ollama server (reachable + model
// pulled) or the Voyage API, depending on EMBED_PROVIDER.
async function checkEmbeddings(cfg: Config): Promise<EmbedProbe> {
  if (cfg.EMBED_PROVIDER === "ollama") {
    const start = Date.now();
    const base = { provider: "ollama", model: cfg.EMBED_MODEL };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(`${cfg.OLLAMA_URL.replace(/\/$/, "")}/api/tags`, {
        signal: ctrl.signal,
      });
      const latencyMs = Date.now() - start;
      if (!res.ok) return { ok: false, latencyMs, error: `ollama ${res.status}`, ...base };
      const json = (await res.json()) as { models?: { name: string }[] };
      const names = (json.models ?? []).map((m) => m.name);
      const present = names.some(
        (n) => n === cfg.EMBED_MODEL || n.split(":")[0] === cfg.EMBED_MODEL
      );
      if (!present) {
        return {
          ok: false,
          latencyMs,
          error: `model "${cfg.EMBED_MODEL}" not pulled (have: ${names.slice(0, 4).join(", ") || "none"})`,
          ...base,
        };
      }
      return { ok: true, latencyMs, ...base };
    } catch (e) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: e instanceof Error ? e.message : String(e),
        ...base,
      };
    } finally {
      clearTimeout(t);
    }
  }
  const v = await checkVoyage(cfg);
  return { ...v, provider: "voyage", model: cfg.EMBED_MODEL };
}

async function checkVoyage(cfg: Config): Promise<ProbeResult> {
  const start = Date.now();
  if (!cfg.VOYAGE_API_KEY) {
    return { ok: false, latencyMs: 0, error: "VOYAGE_API_KEY not set" };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({ input: ["ok"], model: cfg.EMBED_MODEL }),
      signal: ctrl.signal,
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, latencyMs, error: `${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true, latencyMs };
  } catch (e) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(t);
  }
}

async function checkCli(name: string): Promise<ProbeResult> {
  const start = Date.now();
  const resolved = resolveBin(name);
  // resolveBin returns the bare name if not found anywhere on PATH.
  const found = resolved !== name || existsSync(resolved);
  if (!found && basename(resolved) === resolved) {
    return { ok: false, latencyMs: 0, error: `${name} not found on PATH` };
  }
  try {
    const child = Bun.spawn([resolved, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const finished = (async (): Promise<{ code: number; out: string }> => {
      const code = await child.exited;
      const out = await new Response(child.stdout).text().catch(() => "");
      return { code, out };
    })();
    const result = await Promise.race([
      finished,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), CLI_TIMEOUT_MS)),
    ]);
    if (result === null) {
      try {
        child.kill();
      } catch {
        // ignore
      }
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: `${name} --version timed out`,
      };
    }
    const latencyMs = Date.now() - start;
    if (result.code !== 0) {
      return { ok: false, latencyMs, error: `${name} exited ${result.code}` };
    }
    return { ok: true, latencyMs };
  } catch (e) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function checkDb(cfg: Config): DbProbe {
  try {
    const sizeBytes = existsSync(cfg.DB_PATH) ? statSync(cfg.DB_PATH).size : 0;
    const db = openDb(cfg);
    db.exec("SELECT 1");
    return { ok: true, sizeBytes };
  } catch (e) {
    return {
      ok: false,
      sizeBytes: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function checkVault(cfg: Config): Promise<VaultProbe> {
  const path = cfg.VAULT_PATH;
  try {
    const st = statSync(path);
    if (!st.isDirectory()) {
      return { ok: false, path, fileCount: 0, error: "vault path is not a directory" };
    }
    const fileCount = await countMd(path, 1000);
    return { ok: true, path, fileCount };
  } catch (e) {
    return {
      ok: false,
      path,
      fileCount: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function countMd(root: string, cap: number): Promise<number> {
  let count = 0;
  const stack: string[] = [root];
  while (stack.length && count < cap) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (count >= cap) break;
      if (e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
        count++;
      }
    }
  }
  return count;
}

export async function checkHealth(cfg: Config): Promise<HealthReport> {
  const fallback: HealthReport = {
    embeddings: {
      ok: false,
      latencyMs: 0,
      error: "timeout",
      provider: cfg.EMBED_PROVIDER,
      model: cfg.EMBED_MODEL,
    },
    claude: { ok: false, latencyMs: 0, error: "timeout" },
    codex: { ok: false, latencyMs: 0, error: "timeout" },
    gemini: { ok: false, latencyMs: 0, error: "timeout" },
    db: { ok: false, sizeBytes: 0, error: "timeout" },
    vault: { ok: false, path: cfg.VAULT_PATH, fileCount: 0, error: "timeout" },
  };

  const work = (async (): Promise<HealthReport> => {
    const [embeddings, claude, codex, gemini, vault] = await Promise.all([
      checkEmbeddings(cfg).catch((e) => {
        logError("health.embeddings", e);
        return {
          ok: false,
          latencyMs: 0,
          error: String(e),
          provider: cfg.EMBED_PROVIDER,
          model: cfg.EMBED_MODEL,
        } as EmbedProbe;
      }),
      checkCli("claude").catch((e) => {
        logError("health.claude", e);
        return { ok: false, latencyMs: 0, error: String(e) } as ProbeResult;
      }),
      checkCli("codex").catch((e) => {
        logError("health.codex", e);
        return { ok: false, latencyMs: 0, error: String(e) } as ProbeResult;
      }),
      checkCli("gemini").catch((e) => {
        logError("health.gemini", e);
        return { ok: false, latencyMs: 0, error: String(e) } as ProbeResult;
      }),
      checkVault(cfg).catch((e) => {
        logError("health.vault", e);
        return {
          ok: false,
          path: cfg.VAULT_PATH,
          fileCount: 0,
          error: String(e),
        } as VaultProbe;
      }),
    ]);
    const db = checkDb(cfg);
    return { embeddings, claude, codex, gemini, db, vault };
  })();

  return withTimeout(work, OVERALL_TIMEOUT_MS, fallback);
}
