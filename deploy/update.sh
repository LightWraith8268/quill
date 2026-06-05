#!/usr/bin/env bash
# Quill — update + restart, in place. Run on the box:
#   bash ~/quill/deploy/update.sh
#
# Pulls new code (git pull if ~/quill is a clone; else re-syncs from the
# P:\Quill share at /mnt/p/Quill), rebuilds web, restarts the service.
set -euo pipefail

log() { printf '\033[36m[quill]\033[0m %s\n' "$*"; }

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$PWD" == /mnt/* ]]; then
  echo "Run the installed copy: bash ~/quill/deploy/update.sh (not the /mnt source)." >&2
  exit 1
fi
export PATH="$HOME/.bun/bin:$PATH"
SRC="${QUILL_SRC:-/mnt/p/Quill}"

if [[ -d .git ]]; then
  log "git pull"
  git pull --ff-only
elif [[ -d "$SRC" ]]; then
  log "syncing from $SRC"
  rsync -a --delete \
    --exclude node_modules --exclude web/node_modules --exclude web/dist \
    --exclude data --exclude .git --exclude .env \
    "$SRC"/ ./
else
  echo "No .git here and $SRC not found — update the source (re-copy to P:\\Quill) then re-run." >&2
  exit 1
fi

log "installing deps"
bun install
log "building web"
( cd web && bun install && bun run build )

log "restarting service"
systemctl --user restart quill-server
log "done. status: systemctl --user status quill-server"
