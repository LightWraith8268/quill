# Quill

Writing orchestrator with RAG over an Obsidian vault. Sibling to [maestro](../maestro).

Quill indexes your novels, lore, and brainstorm notes, then orchestrates Claude Code, Codex CLI, and Gemini CLI for drafting, structural critique, and full-manuscript continuity sweeps. Built around a single active story at a time, with composable style profiles (genre-neutral base + up to 2 genre overlays).

## Status

All build phases complete: scaffold → embed → search → HTTP API → MCP → web UI (chat / workflows / search / vault / lore / styles / stats) → Cloudflare Tunnel.

## Setup

```bash
cd D:/Coding/quill
bun install

cp .env.example .env
# edit .env: set VAULT_PATH and VOYAGE_API_KEY (and rotate the example HTTP_TOKEN)

bun run src/index.ts reindex --full   # one-time
bun run src/index.ts serve             # http://127.0.0.1:7878
```

For the web UI:

```bash
cd web
bun install
bun run build       # build SPA — Hono serves from web/dist
# or `bun run dev` for hot-reload on http://127.0.0.1:5173 (proxies API to 7878)
```

For Cloudflare Tunnel + Access setup, see [`cloudflared/README.md`](cloudflared/README.md).

## Stack

- **Runtime**: Bun + TypeScript
- **Storage**: SQLite (`bun:sqlite`) + [`sqlite-vec`](https://github.com/asg017/sqlite-vec) extension
- **Embeddings**: Voyage AI `voyage-4-lite` (200M tokens free)
- **Reranker**: Voyage `rerank-2.5-lite` (200M tokens free)
- **HTTP / SSE**: Hono on Bun.serve
- **Web**: Vite + React + Tailwind, served from same port (`/` static, `/api/*` JSON)
- **Agents**: Claude Code CLI, Codex CLI, Gemini CLI — spawned via `Bun.spawn`, stream-json
- **MCP**: stdio shim registered in `~/.claude/.mcp.json` so Claude Code gets the tools
- **Tunnel**: Cloudflared with Cloudflare Access in front

## Vault routing

Folders map to retrieval tags via globs in `.env`:

| Tag | Default glob | Use |
| --- | --- | --- |
| `style` | `Books/**` | Prose chunks for style emulation |
| `lore` | `Books/**, Story Ideas/**` | Worldbuilding facts, continuity recall |
| `uncensored` | `Uncensored/**` | Opt-in per query |

A chunk can carry multiple tags. Search modes filter by tag set.

Style files live in `<vault>/Styles/`:
- `<vault>/Styles/<base>.md` — genre-neutral house style (voice, formatting, anti-patterns)
- `<vault>/Styles/genres/<genre>.md` — genre overlay (sci-fi, urban-fantasy, …). Up to 2 active per story.

## Agents and routing

The chat panel + every workflow can target one of:

| Agent | Best at |
| --- | --- |
| **Claude (Code, 1M ctx)** | Voice-consistent drafting, line edits, anti-pattern adherence, character voice |
| **Codex (GPT-5/o-series)** | Structural critique, plot brainstorming, alternative scene variations |
| **Gemini 2.5 Pro (2M ctx)** | Full-manuscript continuity sweeps, bulk summarization, cross-book lore checks |

Or **Auto-route** — keyword classifier picks the right agent ("brainstorm" → Codex, "continuity sweep" → Gemini, default → Claude).

## Commands

```
quill stats                                Show DB row counts
quill reindex [--full]                     Reindex vault
quill search <query> [--mode lore|style]   Search corpus
quill style list / get <name>              Style profile loader
quill serve                                Start HTTP API + SPA on 127.0.0.1:HTTP_PORT
quill mcp                                  Run MCP stdio server (for Claude Code)
quill tunnel                               Run cloudflared tunnel (cloudflared/config.yml)
```

## HTTP API (selected)

- `POST /api/search` — vector search w/ rerank, mode filter
- `GET /api/style/list`, `/api/style/get/:name`
- `GET /api/genre/list`, `/api/genre/get/:name`
- `POST /api/style/compose` — base + ≤ 2 genres → composed prompt-ready document
- `GET /api/stories/discover`, `GET/POST /api/stories`, `PATCH /api/stories/:id`
- `POST /api/stories/:id/chat` — SSE streaming chat (RAG-augmented)
- `POST /api/stories/:id/workflow` — SSE streaming specialized workflow
- `GET /api/workflows` — workflow definitions (continuity sweep / scene drafter / structural critique)
- `GET /api/vault/tree`, `/api/vault/file?path=`, `/api/vault/resolve?target=`
- `GET /api/lore/entities` — wikilink scan + backlinks
- `GET/POST /api/drafts`, `/api/drafts/:id` — file snapshots independent of git

All API routes require `Authorization: Bearer <HTTP_TOKEN>`.

## MCP tools

Registered as the `quill` MCP server. Claude Code auto-spawns it.

`search_lore`, `search_style`, `search_uncensored`, `list_styles`, `get_style`, `list_genres`, `get_genre`, `compose_style`, `reindex`, `stats`.
