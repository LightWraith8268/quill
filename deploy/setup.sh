#!/usr/bin/env bash
# Quill — WSL install / autostart (Cloudflare tunnel deployment).
# Idempotent: safe to re-run after pulling new code.
#
#   bash deploy/setup.sh        # from the copied/cloned repo
#
# Run it from anywhere; if it's on a Windows drive (/mnt/...) it syncs into the
# WSL ext4 filesystem first (SQLite locking + speed) and installs from there.
set -euo pipefail

log() { printf '\033[36m[quill]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[quill]\033[0m %s\n' "$*" >&2; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${QUILL_DIR:-$HOME/quill}"

# Running off a Windows drive is slow and breaks SQLite WAL locking — sync into
# the WSL filesystem and run from there.
if [[ "$REPO" == /mnt/* ]]; then
  if ! command -v rsync >/dev/null 2>&1; then
    warn "installing rsync (sudo)"
    sudo apt-get update -qq && sudo apt-get install -y rsync
  fi
  log "syncing $REPO -> $TARGET (ext4)"
  mkdir -p "$TARGET"
  rsync -a --delete \
    --exclude node_modules --exclude web/node_modules --exclude web/dist \
    --exclude data --exclude .git --exclude .env \
    "$REPO"/ "$TARGET"/
else
  TARGET="$REPO"
fi
cd "$TARGET"
log "installing into $TARGET"

# --- Bun ---
if ! command -v bun >/dev/null 2>&1; then
  log "installing bun"
  curl -fsSL https://bun.sh/install | bash
fi
export PATH="$HOME/.bun/bin:$PATH"
BUN="$(command -v bun)"
log "bun: $BUN ($("$BUN" --version))"

# --- deps + web build ---
log "installing server deps"
bun install
log "building web"
( cd web && bun install && bun run build )

# --- .env ---
if [[ ! -f .env ]]; then
  cp .env.example .env
  warn "created .env from .env.example — EDIT IT before the service is useful:"
  warn "  VAULT_PATH, VOYAGE_API_KEY, HTTP_TOKEN, CLAUDE_CONFIG_DIR, WRITING_ROOT"
fi
mkdir -p data

# --- cloudflared presence (tunnel configured separately) ---
if ! command -v cloudflared >/dev/null 2>&1; then
  warn "cloudflared not found — install it and configure cloudflared/config.yml"
  warn "  (one-time tunnel setup is in deploy/README.md)."
fi

# --- systemd user services ---
if ! systemctl --user show-environment >/dev/null 2>&1; then
  warn "systemd --user is not available. Enable systemd in WSL, then re-run:"
  warn "  printf '[boot]\\nsystemd=true\\n' | sudo tee -a /etc/wsl.conf"
  warn "  then run 'wsl --shutdown' from Windows and reopen the distro."
  exit 0
fi

UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
for u in quill-server quill-tunnel; do
  sed -e "s#__QUILL_DIR__#$TARGET#g" -e "s#__BUN__#$BUN#g" \
    "$TARGET/deploy/$u.service" > "$UNIT_DIR/$u.service"
done
systemctl --user daemon-reload
systemctl --user enable --now quill-server.service
log "quill-server enabled + started"

if command -v cloudflared >/dev/null 2>&1 && [[ -f "$TARGET/cloudflared/config.yml" ]]; then
  systemctl --user enable --now quill-tunnel.service
  log "quill-tunnel enabled + started"
else
  warn "tunnel NOT started (needs cloudflared + cloudflared/config.yml). Once set up:"
  warn "  systemctl --user enable --now quill-tunnel"
fi

# Keep services running without an interactive login session.
if ! loginctl enable-linger "$USER" >/dev/null 2>&1; then
  sudo loginctl enable-linger "$USER" >/dev/null 2>&1 ||
    warn "could not enable linger; services stop on logout. Run: sudo loginctl enable-linger $USER"
fi

log "done."
log "status:  systemctl --user status quill-server"
log "logs:    journalctl --user -u quill-server -f"
log "deploy:  pull new code, then re-run this script (or restart quill-server)"
