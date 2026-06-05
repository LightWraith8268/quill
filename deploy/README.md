# Quill — WSL deploy (Cloudflare tunnel)

Quill server runs on the WSL box, binds `127.0.0.1:7878`, cloudflared fronts it. Autostart via systemd user services.

## Prereqs (one-time, on the box)

- **WSL2 + systemd.** Enable systemd:
  ```
  printf '[boot]\nsystemd=true\n' | sudo tee -a /etc/wsl.conf
  ```
  then `wsl --shutdown` from Windows, reopen the distro.
- **`claude` CLI** installed + logged in (the writing profile). Quill spawns it for drafting.
- **Voyage API key** (embeddings). Free tier: dashboard.voyageai.com.
- **cloudflared** installed (Cloudflare `.deb`, or distro pkg).

## Install

1. Get the repo onto the box: copy to the `P:\Quill` share (→ `/mnt/p/Quill` in WSL) or `git clone`.
2. Run installer in WSL:
   ```
   bash /mnt/p/Quill/deploy/setup.sh
   ```
   Syncs to `~/quill` (ext4 — never run off `/mnt`, SQLite + speed), installs bun + deps, builds web, writes `.env`, installs + enables the systemd user services, enables linger.
3. Edit `~/quill/.env`:
   - `VAULT_PATH=` your vault (e.g. `/home/riley/writing/Vault`)
   - `WRITING_ROOT=` top folder you open workspaces from (blank = VAULT_PATH)
   - `CLAUDE_CONFIG_DIR=` writing Claude profile (e.g. `/home/riley/.writing/claude`)
   - `VOYAGE_API_KEY=`
   - `HTTP_TOKEN=` bearer token — **set it** (`openssl rand -hex 24`)
4. `systemctl --user restart quill-server`
5. Build the index: `cd ~/quill && bun run src/index.ts reindex` (or it builds lazily on first use).

## Cloudflare tunnel (one-time)

Full steps in `cloudflared/README.md`. Short:

1. `cloudflared tunnel login`
2. `cloudflared tunnel create quill` → note the UUID + creds JSON path
3. `cloudflared tunnel route dns quill quill.<yourdomain>`
4. Edit `~/quill/cloudflared/config.yml`: set `tunnel:` UUID, `credentials-file:`, ingress `hostname:`; service `http://127.0.0.1:7878`.
5. (Optional) Zero Trust → Access → wrap the hostname with SSO/email policy.
6. `systemctl --user enable --now quill-tunnel`

## Manage

- status: `systemctl --user status quill-server quill-tunnel`
- logs: `journalctl --user -u quill-server -f`
- stop: `systemctl --user stop quill-server quill-tunnel`
- **deploy new code:** pull/copy → re-run `bash deploy/setup.sh` (rebuilds web, restarts server). Web-only change: `cd ~/quill/web && bun run build` (dist serves per-request — no restart). Server code change: `systemctl --user restart quill-server`.

## Notes

- **WSL must be running** for the service to be up. Linger keeps systemd services alive while the distro runs, but WSL itself stops when idle. Keep it warm: Windows Task Scheduler at logon → `wsl -d <distro> -u <user> -- sleep infinity` (or just leave a WSL session open).
- **PATH:** the units set a PATH covering `~/.bun/bin` + common dirs. If `which claude` (or `cloudflared`) is elsewhere, edit `~/.config/systemd/user/quill-server.service` `Environment=PATH=...`, then `systemctl --user daemon-reload && systemctl --user restart quill-server`.
- **Auth:** `HTTP_TOKEN` bearer (the web login uses it). Cloudflare Access can layer SSO on top.
- **Direct (no tunnel):** to skip cloudflared and reach it over the tailnet instead, set `HTTP_HOST=0.0.0.0` in `.env` (keep `HTTP_TOKEN` set), open the port, and reach `http://<tailscale-ip>:7878`. WSL2 needs mirrored networking (`.wslconfig` `networkingMode=mirrored`) or Tailscale running inside the distro.
