// Compile a story's manuscripts into a single distributable file.
// Formats: markdown (concat), html (rendered), docx (via Pandoc if available).
// Order resolves the same way as reading-pass: outline first, alphabetic fallback.

import { spawn } from "node:child_process";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { buildReadingPass } from "./reading.ts";
import { resolveBin } from "./agents/resolve.ts";

export type CompileFormat = "md" | "html" | "docx";

const HTML_HEAD = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{{TITLE}}</title>
<style>
  body { font-family: 'EB Garamond', serif; max-width: 720px; margin: 4em auto; line-height: 1.7; padding: 0 1.5em; color: #1a1a1a; }
  h1, h2, h3 { font-family: 'EB Garamond', serif; }
  h1 { page-break-before: always; margin-top: 4em; }
  pre { white-space: pre-wrap; font-family: 'EB Garamond', serif; }
  hr { border: none; text-align: center; margin: 3em 0; }
  hr:before { content: "* * *"; letter-spacing: 1em; }
</style>
</head>
<body>`;

const HTML_TAIL = `</body></html>`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function partsToMd(parts: { title: string; content: string }[]): string {
  return parts.map((p) => `# ${p.title}\n\n${p.content.trim()}`).join("\n\n---\n\n");
}

function partsToHtml(parts: { title: string; content: string }[], title: string): string {
  const body = parts
    .map(
      (p) =>
        `<h1>${escapeHtml(p.title)}</h1>\n<pre>${escapeHtml(p.content.trim())}</pre>`
    )
    .join("\n<hr>\n");
  return HTML_HEAD.replace("{{TITLE}}", escapeHtml(title)) + body + HTML_TAIL;
}

async function pandocAvailable(): Promise<boolean> {
  const bin = resolveBin("pandoc");
  if (bin === "pandoc") return false; // not on PATH
  return true;
}

async function mdToDocx(md: string, outPath: string): Promise<void> {
  const bin = resolveBin("pandoc");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, ["-f", "markdown", "-t", "docx", "-o", outPath], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let err = "";
    child.stderr?.on("data", (d) => (err += d.toString()));
    child.stdin?.write(md);
    child.stdin?.end();
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pandoc exited ${code}: ${err}`));
    });
    child.on("error", reject);
  });
}

export type CompileResult = {
  format: CompileFormat;
  filename: string;
  size: number;
  outAbs: string;
};

export async function compileStory(
  cfg: Config,
  db: DB,
  storyId: number,
  format: CompileFormat,
  outDir?: string
): Promise<CompileResult> {
  const reading = await buildReadingPass(cfg, db, storyId);
  const slug = reading.story.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const date = new Date().toISOString().slice(0, 10);
  const dir = outDir ?? join(process.cwd(), "compiled");
  await mkdir(dir, { recursive: true });

  if (format === "md") {
    const text = partsToMd(reading.parts);
    const filename = `${slug}-${date}.md`;
    const outAbs = join(dir, filename);
    await writeFile(outAbs, text, "utf-8");
    return { format, filename, size: Buffer.byteLength(text, "utf-8"), outAbs };
  }
  if (format === "html") {
    const text = partsToHtml(reading.parts, reading.story.name);
    const filename = `${slug}-${date}.html`;
    const outAbs = join(dir, filename);
    await writeFile(outAbs, text, "utf-8");
    return { format, filename, size: Buffer.byteLength(text, "utf-8"), outAbs };
  }
  if (format === "docx") {
    if (!(await pandocAvailable())) {
      throw new Error(
        "docx requires pandoc on PATH. Install with: winget install JohnMacFarlane.Pandoc"
      );
    }
    const md = partsToMd(reading.parts);
    const filename = `${slug}-${date}.docx`;
    const outAbs = join(dir, filename);
    await mdToDocx(md, outAbs);
    const buf = await readFile(outAbs);
    return { format, filename, size: buf.byteLength, outAbs };
  }
  throw new Error(`unsupported format: ${format}`);
}
