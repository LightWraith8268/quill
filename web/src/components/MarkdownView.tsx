// Markdown renderer with Tailwind-styled overrides matching the dark theme.
// Pre-processes Obsidian-style [[wikilinks]] into anchor links so the click
// handler can intercept them via the standard `a` component override.

import { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

type Props = {
  content: string;
  onWikiClick?: (target: string) => void;
  className?: string;
};

// Match [[Target]], [[Target|Display]], [[Target#heading]], [[Target#heading|Display]]
const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;

function transformWikilinks(input: string): string {
  return input.replace(WIKILINK_RE, (_match, target: string, display?: string) => {
    const trimmedTarget = target.trim();
    const shown = (display ?? trimmedTarget).trim();
    const encoded = encodeURIComponent(trimmedTarget);
    // Escape pipes/brackets in display text so markdown link syntax stays valid.
    const safeDisplay = shown.replace(/[\[\]]/g, "");
    return `[${safeDisplay}](#wiki:${encoded})`;
  });
}

export function MarkdownView({ content, onWikiClick, className }: Props) {
  const transformed = useMemo(() => transformWikilinks(content), [content]);

  const components: Components = useMemo(
    () => ({
      h1: ({ children, ...props }) => (
        <h1
          {...props}
          className="font-display text-2xl text-bg dark:text-paper mt-4 mb-3 pb-1 border-b border-muted/20"
        >
          {children}
        </h1>
      ),
      h2: ({ children, ...props }) => (
        <h2
          {...props}
          className="font-display text-xl text-bg dark:text-paper mt-4 mb-2 pb-1 border-b border-muted/10"
        >
          {children}
        </h2>
      ),
      h3: ({ children, ...props }) => (
        <h3 {...props} className="font-display text-lg text-bg dark:text-paper mt-3 mb-2">
          {children}
        </h3>
      ),
      h4: ({ children, ...props }) => (
        <h4 {...props} className="font-display text-base text-bg dark:text-paper mt-3 mb-1.5">
          {children}
        </h4>
      ),
      h5: ({ children, ...props }) => (
        <h5
          {...props}
          className="font-display text-sm text-bg dark:text-paper mt-2 mb-1 uppercase tracking-wide"
        >
          {children}
        </h5>
      ),
      h6: ({ children, ...props }) => (
        <h6
          {...props}
          className="font-display text-xs text-muted mt-2 mb-1 uppercase tracking-wide"
        >
          {children}
        </h6>
      ),
      p: ({ children, ...props }) => (
        <p {...props} className="font-ui text-bg dark:text-paper my-2 leading-relaxed">
          {children}
        </p>
      ),
      ul: ({ children, ...props }) => (
        <ul {...props} className="list-disc pl-6 my-2 space-y-1 font-ui text-bg dark:text-paper">
          {children}
        </ul>
      ),
      ol: ({ children, ...props }) => (
        <ol {...props} className="list-decimal pl-6 my-2 space-y-1 font-ui text-bg dark:text-paper">
          {children}
        </ol>
      ),
      li: ({ children, ...props }) => (
        <li {...props} className="leading-relaxed">
          {children}
        </li>
      ),
      code: ({ className: codeClass, children, ...props }) => {
        // Inline code only — block code arrives via `pre` > `code`, where the parent
        // `pre` override below handles the styling. react-markdown v9 no longer
        // exposes the `inline` prop, so detect by absence of a language class.
        const isBlock = typeof codeClass === "string" && codeClass.startsWith("language-");
        if (isBlock) {
          return (
            <code className={`${codeClass ?? ""} font-mono text-sm text-bg dark:text-paper`} {...props}>
              {children}
            </code>
          );
        }
        return (
          <code
            className="font-mono text-sm px-1 py-0.5 rounded bg-paper/60 border border-bg/10 dark:bg-bg/60 dark:border-muted/20 text-tealBright"
            {...props}
          >
            {children}
          </code>
        );
      },
      pre: ({ children, ...props }) => (
        <pre
          {...props}
          className="font-mono text-sm bg-paper/60 border border-bg/10 dark:bg-bg/60 dark:border-muted/20 rounded p-3 my-3 overflow-auto text-bg dark:text-paper"
        >
          {children}
        </pre>
      ),
      blockquote: ({ children, ...props }) => (
        <blockquote
          {...props}
          className="border-l-4 border-teal/60 pl-4 my-3 italic text-muted"
        >
          {children}
        </blockquote>
      ),
      table: ({ children, ...props }) => (
        <div className="overflow-auto my-3">
          <table
            {...props}
            className="w-full text-sm font-ui border border-muted/20 rounded"
          >
            {children}
          </table>
        </div>
      ),
      thead: ({ children, ...props }) => (
        <thead {...props} className="bg-bg/60 text-bg dark:text-paper">
          {children}
        </thead>
      ),
      tbody: ({ children, ...props }) => <tbody {...props}>{children}</tbody>,
      tr: ({ children, ...props }) => (
        <tr {...props} className="border-b border-muted/20 last:border-b-0">
          {children}
        </tr>
      ),
      th: ({ children, ...props }) => (
        <th
          {...props}
          className="text-left px-3 py-2 font-display text-bg dark:text-paper border-r border-muted/20 last:border-r-0"
        >
          {children}
        </th>
      ),
      td: ({ children, ...props }) => (
        <td
          {...props}
          className="px-3 py-2 text-bg dark:text-paper border-r border-muted/20 last:border-r-0 align-top"
        >
          {children}
        </td>
      ),
      a: ({ href, children, ...props }) => {
        if (href && href.startsWith("#wiki:")) {
          const target = decodeURIComponent(href.slice("#wiki:".length));
          return (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                onWikiClick?.(target);
              }}
              className="inline px-1 rounded text-tealBright hover:bg-tealBright/20 font-ui"
            >
              [[{children}]]
            </button>
          );
        }
        return (
          <a
            {...props}
            href={href}
            target="_blank"
            rel="noreferrer"
            className="text-tealBright underline decoration-tealBright/40 hover:decoration-tealBright"
          >
            {children}
          </a>
        );
      },
      hr: ({ ...props }) => (
        <hr {...props} className="my-4 border-t border-muted/20" />
      ),
      strong: ({ children, ...props }) => (
        <strong {...props} className="text-bg dark:text-paper font-semibold">
          {children}
        </strong>
      ),
      em: ({ children, ...props }) => (
        <em {...props} className="italic text-bg dark:text-paper">
          {children}
        </em>
      ),
    }),
    [onWikiClick]
  );

  return (
    <div className={`font-ui text-sm leading-relaxed text-bg dark:text-paper ${className ?? ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {transformed}
      </ReactMarkdown>
    </div>
  );
}
