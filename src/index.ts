#!/usr/bin/env bun
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { reindex } from "./reindex.ts";
import { search, type SearchMode } from "./search.ts";
import { listStyles, getStyle } from "./style.ts";
import { serve } from "./http.ts";
import { runMcp } from "./mcp.ts";
import { runTunnel } from "./tunnel.ts";
import { startWatcher } from "./watcher.ts";
import { usageRollup } from "./usage.ts";
import { buildStoryExport } from "./export.ts";
import { extractStory } from "./knowledge/extract.ts";
import { entityCount, factCount } from "./knowledge/store.ts";
import { retrieveCanon } from "./knowledge/retrieve.ts";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const HELP = `quill — writing RAG

Usage:
  quill stats                                Show DB stats
  quill reindex [--full]                     Reindex vault
  quill search <query> [opts]                Search corpus
    --mode <lore|style|uncensored|any>       Default: lore
    --top <n>                                Final hits. Default: 8
    --candidates <n>                         Vector candidates. Default: 40
    --no-rerank                              Skip Voyage rerank
    --json                                   JSON output
  quill style list                           List style profiles
  quill style get <name>                     Print style profile content
  quill serve [--watch]                      Start HTTP API on 127.0.0.1:HTTP_PORT
                                             --watch also auto-reindexes on file changes
  quill watch                                Run file watcher only (auto-reindex)
  quill mcp                                  Run MCP stdio server (for Claude Code)
  quill tunnel                               Run cloudflared tunnel (cloudflared/config.yml)
  quill usage [--story N] [--days 7]         Token usage + approx cost rollup
  quill export <storyId> [--out path]        Export full story bundle as JSON
  quill kb extract <storyId>                 Extract canon graph (entities/facts/relationships)
  quill kb stats [--series S]                Knowledge-layer counts
  quill kb search <query> [--series S]       Canon-aware retrieval (facts + scoped chunks)
    [--book B] [--facts N] [--chunks N] [--json]
`;

function arg(rest: string[], flag: string): string | undefined {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : undefined;
}
function hasFlag(rest: string[], flag: string): boolean {
  return rest.includes(flag);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }
  const cfg = loadConfig();

  switch (cmd) {
    case "stats": {
      const db = openDb(cfg);
      const files = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM files").get()!.n;
      const chunks = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM chunks").get()!.n;
      const vec = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM vec_chunks").get()!.n;
      console.log(JSON.stringify({ files, chunks, vec_rows: vec }, null, 2));
      return;
    }
    case "reindex": {
      const db = openDb(cfg);
      const full = hasFlag(rest, "--full");
      const result = await reindex(cfg, db, { full });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "search": {
      const flags = new Set(["--mode", "--top", "--candidates", "--no-rerank", "--json"]);
      const queryParts: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const v = rest[i]!;
        if (flags.has(v)) {
          if (v !== "--no-rerank" && v !== "--json") i++;
          continue;
        }
        queryParts.push(v);
      }
      const query = queryParts.join(" ").trim();
      if (!query) {
        console.error("search: query is required");
        process.exit(2);
      }
      const mode = (arg(rest, "--mode") ?? "lore") as SearchMode;
      const topK = Number(arg(rest, "--top") ?? 8);
      const candidates = Number(arg(rest, "--candidates") ?? 40);
      const useRerank = !hasFlag(rest, "--no-rerank");
      const asJson = hasFlag(rest, "--json");

      const db = openDb(cfg);
      const hits = await search(cfg, db, query, { mode, topK, candidates, useRerank });

      if (asJson) {
        console.log(JSON.stringify(hits, null, 2));
        return;
      }
      if (hits.length === 0) {
        console.log("(no results)");
        return;
      }
      for (const h of hits) {
        const score = h.rerankScore ?? 1 - h.vectorDistance;
        const heading = h.headingPath ? ` :: ${h.headingPath}` : "";
        console.log(
          `\n[${score.toFixed(3)}] ${h.filePath}${heading} (L${h.startLine}-${h.endLine}) [${h.tags}]`
        );
        const preview = h.content.length > 600 ? h.content.slice(0, 600) + "…" : h.content;
        console.log(preview);
      }
      return;
    }
    case "style": {
      const sub = rest[0];
      if (sub === "list") {
        const styles = await listStyles(cfg);
        if (styles.length === 0) {
          console.log("(no style profiles in <vault>/Styles/)");
          return;
        }
        for (const s of styles) {
          console.log(`${s.name}\t${s.bytes}B\t${s.path}`);
        }
        return;
      }
      if (sub === "get") {
        const name = rest[1];
        if (!name) {
          console.error("style get: name required");
          process.exit(2);
        }
        const profile = await getStyle(cfg, name);
        if (!profile) {
          console.error(`style get: "${name}" not found`);
          process.exit(1);
        }
        console.log(profile.content);
        return;
      }
      console.error("style: subcommand required (list|get <name>)");
      process.exit(2);
      return;
    }
    case "serve": {
      serve(cfg);
      const wantWatch = hasFlag(rest, "--watch") || cfg.QUILL_AUTO_REINDEX;
      if (wantWatch) {
        const db = openDb(cfg);
        const stop = startWatcher(cfg, db, {
          debounceMs: cfg.WATCH_DEBOUNCE_MS,
        });
        const shutdown = (): void => {
          stop();
          process.exit(0);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
      }
      return;
    }
    case "watch": {
      const db = openDb(cfg);
      console.log(`[watcher] watching ${cfg.VAULT_PATH}`);
      const stop = startWatcher(cfg, db, {
        debounceMs: cfg.WATCH_DEBOUNCE_MS,
      });
      const shutdown = (): void => {
        stop();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      // Keep process alive
      await new Promise<void>(() => {});
      return;
    }
    case "mcp": {
      await runMcp(cfg);
      return;
    }
    case "tunnel": {
      const code = await runTunnel(process.cwd());
      process.exit(code);
    }
    case "usage": {
      const db = openDb(cfg);
      const storyArg = arg(rest, "--story");
      const daysArg = arg(rest, "--days");
      const storyId = storyArg ? Number(storyArg) : undefined;
      const days = daysArg ? Number(daysArg) : undefined;
      const since =
        days && Number.isFinite(days) ? Date.now() - days * 86_400_000 : undefined;
      const rollup = usageRollup(db, { storyId, since });
      console.log(JSON.stringify(rollup, null, 2));
      return;
    }
    case "export": {
      const idArg = rest[0];
      if (!idArg || idArg.startsWith("--")) {
        console.error("export: storyId required");
        process.exit(2);
      }
      const storyId = Number(idArg);
      if (!Number.isFinite(storyId)) {
        console.error(`export: invalid storyId "${idArg}"`);
        process.exit(2);
      }
      const db = openDb(cfg);
      const { filename, payload } = await buildStoryExport(cfg, db, storyId);
      const outArg = arg(rest, "--out");
      const outPath = resolve(process.cwd(), outArg ?? filename);
      await writeFile(outPath, payload, "utf-8");
      console.log(
        JSON.stringify(
          { ok: true, path: outPath, bytes: Buffer.byteLength(payload, "utf-8") },
          null,
          2
        )
      );
      return;
    }
    case "kb": {
      const sub = rest[0];
      const db = openDb(cfg);
      if (sub === "extract") {
        const idArg = rest[1];
        const storyId = Number(idArg);
        if (!idArg || !Number.isFinite(storyId)) {
          console.error("kb extract: storyId required");
          process.exit(2);
        }
        const result = await extractStory(cfg, db, storyId);
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (sub === "stats") {
        const series = arg(rest, "--series");
        console.log(
          JSON.stringify(
            { entities: entityCount(db, series), facts: factCount(db, series) },
            null,
            2
          )
        );
        return;
      }
      if (sub === "search") {
        const flags = new Set(["--series", "--book", "--facts", "--chunks", "--json"]);
        const qparts: string[] = [];
        for (let i = 1; i < rest.length; i++) {
          const v = rest[i]!;
          if (flags.has(v)) {
            if (v !== "--json") i++;
            continue;
          }
          qparts.push(v);
        }
        const query = qparts.join(" ").trim();
        if (!query) {
          console.error("kb search: query required");
          process.exit(2);
        }
        const items = await retrieveCanon(cfg, db, query, {
          scope: { series: arg(rest, "--series") ?? null, book: arg(rest, "--book") ?? null },
          factK: Number(arg(rest, "--facts") ?? 8),
          chunkK: Number(arg(rest, "--chunks") ?? 6),
        });
        if (hasFlag(rest, "--json")) {
          console.log(JSON.stringify(items, null, 2));
          return;
        }
        for (const it of items) {
          const tag = it.kind === "chunk" ? "chunk" : `${it.kind}:${it.canonWeight}`;
          const who = it.entity ? `${it.entity} — ` : "";
          console.log(`[${tag}] ${who}${it.text.slice(0, 120)}`);
        }
        return;
      }
      console.error(
        "kb: subcommand required (extract <storyId> | stats [--series S] | search <query>)"
      );
      process.exit(2);
      return;
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error(HELP);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
