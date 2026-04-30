import { z } from "zod";

const Schema = z.object({
  VAULT_PATH: z.string().min(1),
  DB_PATH: z.string().default("./data/quill.db"),
  VOYAGE_API_KEY: z.string().default(""),
  EMBED_MODEL: z.string().default("voyage-4-lite"),
  RERANK_MODEL: z.string().default("rerank-2.5-lite"),
  EMBED_DIM: z.coerce.number().default(1024),
  STYLE_INCLUDE: z.string().default("Books/**"),
  LORE_INCLUDE: z.string().default("Books/**,Story Ideas/**"),
  UNCENSORED_INCLUDE: z.string().default("Uncensored/**"),
  CHUNK_TOKENS: z.coerce.number().default(500),
  CHUNK_OVERLAP: z.coerce.number().default(50),
  EMBED_RPM: z.coerce.number().default(3),
  EMBED_TPM: z.coerce.number().default(10000),
  EMBED_RETRY_MAX: z.coerce.number().default(6),
  HTTP_PORT: z.coerce.number().default(7878),
  HTTP_TOKEN: z.string().default(""),
  HYBRID_BM25: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() === "true"),
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
