// Cloudflare tunnel runner. Spawns `cloudflared tunnel run` against the project's
// config file. Streams stdout/stderr to console.
//
// One-time setup (user-side):
//   1. cloudflared tunnel login
//   2. cloudflared tunnel create quill         → prints UUID + creds JSON path
//   3. cloudflared tunnel route dns quill <hostname>
//   4. Edit cloudflared/config.yml:
//      - set `tunnel:` to UUID
//      - set `credentials-file:` to the JSON path
//      - set `hostname:` under ingress
//   5. (Optional) Cloudflare Zero Trust → Access → Application → wrap hostname
//      with email/SSO policy
//   6. quill tunnel
//
// Persistent service (optional):
//   cloudflared service install   (Windows: installs as service)

import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveBin } from "./agents/resolve.ts";

const WINDOWS_DEFAULT = "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe";

function locateCloudflared(): string {
  const fromPath = resolveBin("cloudflared");
  if (fromPath !== "cloudflared") return fromPath;
  if (process.platform === "win32" && existsSync(WINDOWS_DEFAULT)) {
    return WINDOWS_DEFAULT;
  }
  return "cloudflared";
}

export async function runTunnel(projectDir: string): Promise<number> {
  const configPath = join(projectDir, "cloudflared", "config.yml");
  if (!existsSync(configPath)) {
    console.error(`tunnel: missing ${configPath}`);
    console.error(`See cloudflared/README.md for setup steps.`);
    return 2;
  }
  const bin = locateCloudflared();
  console.log(`[tunnel] running ${bin} with ${configPath}`);
  const child = Bun.spawn([bin, "tunnel", "--config", configPath, "run"], {
    cwd: projectDir,
    stdout: "inherit",
    stderr: "inherit",
  });
  return await child.exited;
}
