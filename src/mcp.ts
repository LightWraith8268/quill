// MCP stdio server. Exposes Quill RAG tools to Claude Code.
// Tools: search_lore, search_style, search_uncensored, get_style, list_styles,
// reindex, stats.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.ts";
import { openDb } from "./db.ts";
import { reindex } from "./reindex.ts";
import { search, type SearchMode } from "./search.ts";
import { listStyles, getStyle, listGenres, getGenre, composeStyle } from "./style.ts";

type SearchArgs = {
  query?: string;
  top_k?: number;
  candidates?: number;
  rerank?: boolean;
};

const TOOLS = [
  {
    name: "search_lore",
    description:
      "Semantic search across the writing vault for worldbuilding facts, character canon, and continuity details. Filters to chunks tagged 'lore' (Books/, Story Ideas/). Returns ranked passages with file path and heading.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query" },
        top_k: { type: "number", description: "Number of hits (default 8)", default: 8 },
        candidates: {
          type: "number",
          description: "Vector candidates before rerank (default 40)",
          default: 40,
        },
        rerank: { type: "boolean", description: "Use Voyage rerank (default true)", default: true },
      },
      required: ["query"],
    },
  },
  {
    name: "search_style",
    description:
      "Semantic search for prose passages exemplifying a writing style or voice. Filters to chunks tagged 'style' (manuscript prose under Books/). Use for style emulation few-shot examples.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        top_k: { type: "number", default: 8 },
        candidates: { type: "number", default: 40 },
        rerank: { type: "boolean", default: true },
      },
      required: ["query"],
    },
  },
  {
    name: "search_uncensored",
    description:
      "Opt-in search across the Uncensored/ folder. Use only when explicitly requested.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        top_k: { type: "number", default: 8 },
        candidates: { type: "number", default: 40 },
        rerank: { type: "boolean", default: true },
      },
      required: ["query"],
    },
  },
  {
    name: "list_styles",
    description: "List base style profiles in <vault>/Styles/ (excludes genre overlays).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_style",
    description:
      "Load a full base style profile by name (e.g. 'house-style'). Returns the entire markdown — voice rules, anti-pattern bible, revision checklist.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "list_genres",
    description: "List genre overlays in <vault>/Styles/genres/ (e.g. sci-fi, urban-fantasy).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_genre",
    description: "Load a single genre overlay by name.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "compose_style",
    description:
      "Compose a base style + up to 2 genre overlays into one combined style document. Use this to load the full active style for a story.",
    inputSchema: {
      type: "object",
      properties: {
        base: { type: "string", description: "Base profile name (e.g. 'house-style')" },
        genres: {
          type: "array",
          items: { type: "string" },
          maxItems: 2,
          description: "Up to 2 genre overlay names",
        },
      },
      required: ["base"],
    },
  },
  {
    name: "reindex",
    description:
      "Reindex the vault. Walks files, diffs against stored hashes, re-embeds changed chunks. Pass full=true to rebuild everything.",
    inputSchema: {
      type: "object",
      properties: { full: { type: "boolean", default: false } },
    },
  },
  {
    name: "stats",
    description: "Return DB stats: file count, chunk count, vector row count.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

function asText(v: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
  };
}

export async function runMcp(cfg: Config): Promise<void> {
  const db = openDb(cfg);
  const server = new Server(
    { name: "quill", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;

    const doSearch = async (mode: SearchMode) => {
      const a = args as SearchArgs;
      if (!a.query) throw new Error("query required");
      const hits = await search(cfg, db, a.query, {
        mode,
        topK: a.top_k ?? 8,
        candidates: a.candidates ?? 40,
        useRerank: a.rerank ?? true,
      });
      return asText({ hits });
    };

    switch (name) {
      case "search_lore":
        return doSearch("lore");
      case "search_style":
        return doSearch("style");
      case "search_uncensored":
        return doSearch("uncensored");
      case "list_styles": {
        const styles = await listStyles(cfg);
        return asText({ styles });
      }
      case "get_style": {
        const styleName = (args as { name?: string }).name;
        if (!styleName) throw new Error("name required");
        const profile = await getStyle(cfg, styleName);
        if (!profile) throw new Error(`style "${styleName}" not found`);
        return asText(profile.content);
      }
      case "list_genres": {
        const genres = await listGenres(cfg);
        return asText({ genres });
      }
      case "get_genre": {
        const gName = (args as { name?: string }).name;
        if (!gName) throw new Error("name required");
        const g = await getGenre(cfg, gName);
        if (!g) throw new Error(`genre "${gName}" not found`);
        return asText(g.content);
      }
      case "compose_style": {
        const a = args as { base?: string; genres?: string[] };
        if (!a.base) throw new Error("base required");
        const composed = await composeStyle(cfg, a.base, a.genres ?? []);
        if (!composed) throw new Error("base or genre not found");
        return asText(composed);
      }
      case "reindex": {
        const full = (args as { full?: boolean }).full ?? false;
        const result = await reindex(cfg, db, { full });
        return asText(result);
      }
      case "stats": {
        const files = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM files").get()!.n;
        const chunks = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM chunks").get()!.n;
        const vec = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM vec_chunks").get()!.n;
        return asText({ files, chunks, vec_rows: vec });
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
