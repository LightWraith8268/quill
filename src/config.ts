import { z } from "zod";

const Schema = z.object({
  VAULT_PATH: z.string().min(1),
  DB_PATH: z.string().default("./data/quill.db"),
  // Embedding backend. "voyage" = Voyage AI API (needs VOYAGE_API_KEY).
  // "ollama" = a local Ollama server (free, unlimited, no key) — set
  // EMBED_MODEL to a local model (e.g. nomic-embed-text) and EMBED_DIM to its
  // native dimension (nomic-embed-text = 768). Rerank is skipped without a
  // Voyage key (hybrid BM25 + vector RRF still applies).
  EMBED_PROVIDER: z.enum(["voyage", "ollama"]).default("voyage"),
  OLLAMA_URL: z.string().default("http://127.0.0.1:11434"),
  VOYAGE_API_KEY: z.string().default(""),
  EMBED_MODEL: z.string().default("voyage-4-lite"),
  RERANK_MODEL: z.string().default("rerank-2.5-lite"),
  EMBED_DIM: z.coerce.number().default(1024),
  STYLE_INCLUDE: z.string().default("Books/**"),
  LORE_INCLUDE: z.string().default("Books/**,Story Ideas/**"),
  UNCENSORED_INCLUDE: z.string().default("Uncensored/**"),
  CHUNK_TOKENS: z.coerce.number().default(500),
  CHUNK_OVERLAP: z.coerce.number().default(50),
  // Series/book scope detection from a folder path. Comma-separated patterns;
  // segments are literals or :series / :book placeholders. First match wins.
  // Add your tree's shape, e.g. novels/series/:series/books/:book
  SCOPE_PATTERNS: z.string().default("Books/:series/:book,Story Ideas/:series"),
  EMBED_RPM: z.coerce.number().default(3),
  EMBED_TPM: z.coerce.number().default(10000),
  EMBED_RETRY_MAX: z.coerce.number().default(6),
  HTTP_PORT: z.coerce.number().default(7878),
  // Bind address. 127.0.0.1 (default) = localhost only — correct behind a
  // cloudflared tunnel. Set 0.0.0.0 to expose on the LAN / tailnet directly.
  HTTP_HOST: z.string().default("127.0.0.1"),
  HTTP_TOKEN: z.string().default(""),
  // Top of the writing tree you can open folders from (defaults to VAULT_PATH).
  WRITING_ROOT: z.string().default(""),
  // Point the Claude agent at a custom profile dir (its own CLAUDE.md, settings,
  // creds) instead of ~/.claude — e.g. a writing-tuned profile. Inherited by the
  // spawned Claude CLI via the process env.
  CLAUDE_CONFIG_DIR: z.string().default(""),
  HYBRID_BM25: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() === "true"),
  QUILL_AUTO_REINDEX: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  WATCH_DEBOUNCE_MS: z.coerce.number().default(500),
});

export type Config = z.infer<typeof Schema>;

export function loadConfig(): Config {
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Config error:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

export function splitGlobs(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}
