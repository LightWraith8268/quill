# Quill — Cloudflare Tunnel + Access setup

This wraps Quill's local HTTP server (port `7878`) behind a Cloudflare Tunnel
gated by Cloudflare Access. Result: you can reach the Quill web UI from
any browser, but only authenticated identities you allow get past CF's auth gate.

The Quill bearer token (`HTTP_TOKEN`) still applies as a second factor for
the API.

## One-time setup

Cloudflare account with a domain on Cloudflare DNS is required.

1. **Authenticate cloudflared with your CF account.**

   ```bash
   cloudflared tunnel login
   ```

   Browser opens; pick the zone (your domain) and authorize.

2. **Create the tunnel.**

   ```bash
   cloudflared tunnel create quill
   ```

   Output prints the **tunnel UUID** and the path to a credentials JSON
   (typically `C:\Users\<you>\.cloudflared\<UUID>.json`).

3. **Route a hostname to the tunnel.**

   Pick a hostname on your CF-managed domain, e.g. `quill.example.com`.

   ```bash
   cloudflared tunnel route dns quill quill.example.com
   ```

   This creates a `CNAME` pointing the hostname at the tunnel.

4. **Configure the tunnel.**

   Copy the example config and fill in the values from steps 2 and 3:

   ```bash
   cp cloudflared/config.example.yml cloudflared/config.yml
   ```

   Edit `cloudflared/config.yml`:
   - Set `tunnel:` to the UUID from step 2.
   - Set `credentials-file:` to the JSON path from step 2.
   - Set `hostname:` to the hostname from step 3.

5. **Wrap the hostname with Cloudflare Access (recommended).**

   Cloudflare Zero Trust dashboard → **Access** → **Applications** →
   **Add an application** → **Self-hosted**.
   - Application name: `Quill`
   - Subdomain: `quill`
   - Domain: `example.com` (your domain)
   - **Identity providers**: enable email OTP and/or your SSO (Google, GitHub, etc).
   - Add a **policy**: `Allow` if email matches your address (`you@example.com`).

   Without this, the tunnel is publicly reachable. The Quill bearer token
   would still gate the API, but the SPA shell and any non-API paths
   would be open. Always wrap with Access.

## Run

From the Quill repo:

```bash
# in one shell: Quill HTTP server
bun run src/index.ts serve

# in another: the tunnel
bun run src/index.ts tunnel
```

Or install cloudflared as a Windows service for auto-start:

```bash
"C:\Program Files (x86)\cloudflared\cloudflared.exe" service install
```

## Verify

- Open `https://quill.<your-domain>` — Cloudflare Access prompts for auth.
- After auth, the Quill SPA loads.
- Enter the bearer token from `.env` (`HTTP_TOKEN`).
- The Chat / Workflows / Search / Vault / Lore / Styles / Stats tabs work
  exactly as on `localhost:7878`.

## Troubleshooting

- **401 from API after passing Access**: confirm `HTTP_TOKEN` matches.
- **SSE chat hangs** without deltas: a proxy or middlebox is buffering.
  The `disableChunkedEncoding: false` + Hono SSE response headers should
  prevent this on the CF side. Check that no corporate proxy sits in front.
- **Tunnel won't start**: re-run `cloudflared tunnel login` — credentials
  expire eventually.
- **`cloudflared` not on PATH**: `quill tunnel` falls back to
  `C:\Program Files (x86)\cloudflared\cloudflared.exe` on Windows.
