// Markdown-aware chunker. Splits on headings + paragraph blocks, packs to ~CHUNK_TOKENS
// with CHUNK_OVERLAP. Tracks heading_path + line spans. Token estimate: chars/4.

export type RawChunk = {
  ord: number;
  headingPath: string;
  startLine: number;
  endLine: number;
  tokenCount: number;
  content: string;
};

type Block = {
  startLine: number;
  endLine: number;
  text: string;
  headingPath: string;
};

const tokens = (s: string): number => Math.ceil(s.length / 4);

function stripFrontmatter(src: string): { body: string; offset: number } {
  if (!src.startsWith("---\n") && !src.startsWith("---\r\n")) {
    return { body: src, offset: 0 };
  }
  const m = src.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (!m) return { body: src, offset: 0 };
  const offset = m[0].split(/\r?\n/).length - 1;
  return { body: src.slice(m[0].length), offset };
}

function blocks(src: string, lineOffset: number): Block[] {
  const lines = src.split(/\r?\n/);
  const out: Block[] = [];
  const headings: string[] = [];
  let buf: string[] = [];
  let bufStart = 0;

  const flush = (endLine: number): void => {
    const text = buf.join("\n").trim();
    if (text) {
      out.push({
        startLine: bufStart + lineOffset + 1,
        endLine: endLine + lineOffset + 1,
        text,
        headingPath: headings.filter(Boolean).join(" > "),
      });
    }
    buf = [];
    bufStart = endLine + 1;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush(i - 1);
      const depth = h[1]!.length;
      const title = h[2]!.trim();
      headings.length = depth - 1;
      headings[depth - 1] = title;
      bufStart = i;
      buf.push(line);
      flush(i);
      continue;
    }
    if (line.trim() === "" && buf.length > 0) {
      flush(i - 1);
      bufStart = i + 1;
      continue;
    }
    if (buf.length === 0) bufStart = i;
    buf.push(line);
  }
  flush(lines.length - 1);
  return out;
}

export function chunkMarkdown(
  src: string,
  opts: { chunkTokens: number; overlap: number }
): RawChunk[] {
  const { body, offset } = stripFrontmatter(src);
  const bs = blocks(body, offset);
  const out: RawChunk[] = [];
  let cur: Block[] = [];
  let curTokens = 0;
  let ord = 0;

  const emit = (): void => {
    if (cur.length === 0) return;
    const first = cur[0]!;
    const last = cur[cur.length - 1]!;
    const text = cur.map((b) => b.text).join("\n\n");
    out.push({
      ord: ord++,
      headingPath: first.headingPath || last.headingPath,
      startLine: first.startLine,
      endLine: last.endLine,
      tokenCount: tokens(text),
      content: text,
    });
  };

  for (const b of bs) {
    const t = tokens(b.text);
    if (curTokens + t > opts.chunkTokens && cur.length > 0) {
      emit();
      // overlap: keep tail blocks summing to ~overlap tokens
      const tail: Block[] = [];
      let tailTokens = 0;
      for (let i = cur.length - 1; i >= 0 && tailTokens < opts.overlap; i--) {
        const blk = cur[i]!;
        tail.unshift(blk);
        tailTokens += tokens(blk.text);
      }
      cur = tail;
      curTokens = tailTokens;
    }
    cur.push(b);
    curTokens += t;
  }
  emit();
  return out;
}
