# Quill

Writing orchestrator with RAG over an Obsidian vault.

Quill indexes your novels, lore, and brainstorm notes, then orchestrates Claude Code, Codex CLI, and Gemini CLI for drafting, structural critique, and full-manuscript continuity sweeps. Built around a single active story at a time, with composable style profiles (genre-neutral base + up to 2 genre overlays).

## Status

All build phases complete: scaffold → embed → search → HTTP API → MCP → web UI (chat / workflows / search / vault / lore / styles / stats) → Cloudflare Tunnel.

## Requirements

- [Bun](https://bun.sh) 1.1+
- An [Obsidian](https://obsidian.md) vault (or any folder of `.md` files)
- A [Voyage AI](https://dashboard.voyageai.com) API key (free tier: 200M tokens)
- Optional: [Claude Code](https://claude.com/claude-code), [Codex CLI](https://github.com/openai/codex), and/or [Gemini CLI](https://github.com/google-gemini/gemini-cli) on `PATH`

## Setup

```bash
# 1. Clone + install
git clone https://github.com/<you>/quill.git
cd quill
bun install
(cd web && bun install && bun run build)   # SPA — Hono serves it from web/dist

# 2. Configure
cp .env.example .env
# edit .env: set VAULT_PATH, VOYAGE_API_KEY, and HTTP_TOKEN (openssl rand -hex 24)

# 3. Seed style profiles (optional but recommended — you can edit / replace)
mkdir -p "$VAULT_PATH/Styles/genres"
cp examples/Styles/house-style.md "$VAULT_PATH/Styles/"
cp examples/Styles/genres/*.md    "$VAULT_PATH/Styles/genres/"

# 4. Index + serve
bun run src/index.ts reindex --full        # one-time
bun run src/index.ts serve                 # http://127.0.0.1:7878
```

Open `http://127.0.0.1:7878`, paste your `HTTP_TOKEN` to log in.

For frontend hot-reload during dev: `(cd web && bun run dev)` → `http://127.0.0.1:5173` (proxies API to 7878).

For Cloudflare Tunnel + Access setup (remote access), see [`cloudflared/README.md`](cloudflared/README.md).

### MCP registration (optional — for Claude Code integration)

If you have [Claude Code](https://claude.com/claude-code) installed and want the `search_lore` / `compose_style` / `reindex` tools available inside Claude Code:

```bash
claude mcp add quill -- bun run /absolute/path/to/quill/src/index.ts mcp
```

Or edit `~/.claude/.mcp.json` directly:

```json
{
  "mcpServers": {
    "quill": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/quill/src/index.ts", "mcp"],
      "env": { "QUILL_HOME": "/absolute/path/to/quill" }
    }
  }
}
```

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

Run as `bun run src/index.ts <cmd>`, or `bun link` once inside the repo to expose a global `quill` binary.

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

## Roadmap notes (deferred)

- **Multi-user collaboration** (#36 in design notes). Currently single-user (one bearer token). Multi-user requires per-user auth, permissions, presence, comment threads. Significant. Not in scope for v1.
- **Self-hosted Whisper / local TTS** (#37). Voice-to-text uses the browser Web Speech API (cloud-routed). For full local privacy: install Whisper locally + bridge via `quill stt` CLI hook. Not in scope for v1.

## MCP tools

Registered as the `quill` MCP server. Claude Code auto-spawns it.

`search_lore`, `search_style`, `search_uncensored`, `list_styles`, `get_style`, `list_genres`, `get_genre`, `compose_style`, `reindex`, `stats`.

## License

MIT — see [LICENSE](LICENSE).
