import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { reindex } from "./reindex.ts";
import { search, type SearchMode } from "./search.ts";
import { listStyles, getStyle } from "./style.ts";
import { serve } from "./http.ts";
import { runMcp } from "./mcp.ts";
import { runTunnel } from "./tunnel.ts";

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
  quill serve                                Start HTTP API on 127.0.0.1:HTTP_PORT
  quill mcp                                  Run MCP stdio server (for Claude Code)
  quill tunnel                               Run cloudflared tunnel (cloudflared/config.yml)
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
