// Research clipper: fetch a URL, extract readable content, save as
// Research/<slug>.md in the vault. Optionally summarize via Claude.
//
// Plain text/HTML extraction is intentionally minimal — strip tags, collapse
// whitespace. For complex sites the user can paste manually.

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";

function htmlToText(html: string): { title: string; text: string } {
  // Title
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = (titleM?.[1] ?? "").trim().replace(/\s+/g, " ");
  // Strip script/style
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  // Replace block-level tags with newlines
  body = body
    .replace(/<\/(p|div|article|section|li|h[1-6]|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  // Strip remaining tags
  body = body.replace(/<[^>]+>/g, "");
  // Decode common entities
  body = body
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // Collapse whitespace, trim, preserve paragraph breaks
  body = body
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0)
    .join("\n\n");
  return { title, text: body };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

export type ClipResult = {
  url: string;
  title: string;
  vaultPath: string;
  bytes: number;
  textLength: number;
};

export async function clipUrl(
  cfg: Config,
  url: string,
  opts: { topic?: string } = {}
): Promise<ClipResult> {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Quill research clipper; +https://github.com/inkironapps/quill)",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const html = await res.text();
  const { title, text } = htmlToText(html);
  const slug = slugify(opts.topic ?? title ?? new URL(url).hostname);
  const date = new Date().toISOString().slice(0, 10);
  const filename = `${date}-${slug || "untitled"}.md`;
  const dir = join(cfg.VAULT_PATH, "Research");
  await mkdir(dir, { recursive: true });
  const md = [
    `---`,
    `title: ${JSON.stringify(title || "untitled")}`,
    `source: ${url}`,
    `clipped_at: ${new Date().toISOString()}`,
    opts.topic ? `topic: ${JSON.stringify(opts.topic)}` : null,
    `---`,
    ``,
    `# ${title || "Untitled"}`,
    ``,
    `> Source: <${url}>`,
    ``,
    text,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
  const out = join(dir, filename);
  await writeFile(out, md, "utf-8");
  return {
    url,
    title: title || "Untitled",
    vaultPath: `Research/${filename}`,
    bytes: Buffer.byteLength(md, "utf-8"),
    textLength: text.length,
  };
}
