// CodeMirror 6 markdown editor for in-app editing of vault files.
// Wraps EditorView with markdown lang + line wrapping; switches to oneDark
// when dark theme is active.

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, hoverTooltip } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { basicSetup } from "codemirror";
import { antiPatternLinter } from "../editor/linter.ts";

export type MarkdownEditorHandle = {
  replaceRange: (from: number, to: number, text: string) => void;
  insertAt: (pos: number, text: string) => void;
  getCursor: () => number;
};

export type CanonEntity = { id: number; names: string[] };
export type CanonFact = { canon_weight: string; claim: string };

type Props = {
  initialContent: string;
  onChange: (content: string) => void;
  onSaveShortcut?: () => void;
  onCommandK?: (selection: string, replaceRange: { from: number; to: number }) => void;
  onTabContinue?: (precedingText: string, cursorPos: number) => void;
  readOnly?: boolean;
  theme?: "light" | "dark";
  // Hovering a canon entity's name shows its facts (knowledge-graph lookup).
  entities?: CanonEntity[];
  onEntityFacts?: (id: number) => Promise<CanonFact[]>;
};

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, Props>(function MarkdownEditor(
  {
    initialContent,
    onChange,
    onSaveShortcut,
    onCommandK,
    onTabContinue,
    readOnly = false,
    theme,
    entities,
    onEntityFacts,
  }: Props,
  externalRef
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const entityIndexRef = useRef<Map<string, number>>(new Map());
  const onFactsRef = useRef(onEntityFacts);
  const onSaveRef = useRef(onSaveShortcut);
  const onCommandKRef = useRef(onCommandK);
  const onTabContinueRef = useRef(onTabContinue);
  const themeCompartmentRef = useRef(new Compartment());
  const readOnlyCompartmentRef = useRef(new Compartment());

  // Keep latest callbacks without re-creating the editor.
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    onSaveRef.current = onSaveShortcut;
  }, [onSaveShortcut]);
  useEffect(() => {
    onCommandKRef.current = onCommandK;
  }, [onCommandK]);
  useEffect(() => {
    onTabContinueRef.current = onTabContinue;
  }, [onTabContinue]);
  useEffect(() => {
    onFactsRef.current = onEntityFacts;
  }, [onEntityFacts]);
  useEffect(() => {
    const idx = new Map<string, number>();
    for (const e of entities ?? [])
      for (const nm of e.names)
        for (const tok of nm.toLowerCase().split(/[^a-z0-9]+/))
          if (tok.length >= 3 && !idx.has(tok)) idx.set(tok, e.id);
    entityIndexRef.current = idx;
  }, [entities]);

  const resolvedTheme: "light" | "dark" =
    theme ??
    (typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
      ? "dark"
      : "light");

  // Mount editor once.
  useEffect(() => {
    if (!hostRef.current) return;
    const saveKeymap = keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          onSaveRef.current?.();
          return true;
        },
      },
      {
        key: "Mod-k",
        preventDefault: true,
        run: (view) => {
          if (!onCommandKRef.current) return false;
          const sel = view.state.selection.main;
          if (sel.from === sel.to) return false;
          const text = view.state.doc.sliceString(sel.from, sel.to);
          onCommandKRef.current(text, { from: sel.from, to: sel.to });
          return true;
        },
      },
      {
        key: "Tab",
        run: (view) => {
          if (!onTabContinueRef.current) return false;
          const sel = view.state.selection.main;
          if (sel.from !== sel.to) return false; // only at single cursor
          const pos = sel.from;
          // Only when cursor sits at end of a non-empty line
          const line = view.state.doc.lineAt(pos);
          if (pos !== line.to) return false;
          if (line.text.trim().length === 0) return false;
          // Use up to 1500 chars before cursor as context
          const start = Math.max(0, pos - 1500);
          const preceding = view.state.doc.sliceString(start, pos);
          onTabContinueRef.current(preceding, pos);
          return true;
        },
      },
    ]);

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current(update.state.doc.toString());
      }
    });

    // Hovering a canon entity's name shows its facts (knowledge-graph lookup).
    const canonHover = hoverTooltip(async (view, pos) => {
      const idx = entityIndexRef.current;
      const fetchFacts = onFactsRef.current;
      if (idx.size === 0 || !fetchFacts) return null;
      const line = view.state.doc.lineAt(pos);
      const rel = pos - line.from;
      const re = /[A-Za-z0-9'’-]+/g;
      let word: { from: number; to: number; text: string } | null = null;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line.text)) !== null) {
        if (m.index <= rel && rel <= m.index + m[0].length) {
          word = {
            from: line.from + m.index,
            to: line.from + m.index + m[0].length,
            text: m[0],
          };
          break;
        }
      }
      if (!word) return null;
      const id = idx.get(word.text.toLowerCase());
      if (id === undefined) return null;
      let facts: CanonFact[];
      try {
        facts = await fetchFacts(id);
      } catch {
        return null;
      }
      if (!facts.length) return null;
      return {
        pos: word.from,
        end: word.to,
        above: true,
        create: () => {
          const dom = document.createElement("div");
          dom.style.cssText =
            "max-width:340px;padding:6px 8px;font-size:12px;line-height:1.45;";
          for (const f of facts.slice(0, 6)) {
            const row = document.createElement("div");
            const w = document.createElement("span");
            w.textContent = `${f.canon_weight.replace(/_/g, " ")}: `;
            w.style.opacity = "0.6";
            row.appendChild(w);
            row.appendChild(document.createTextNode(f.claim));
            dom.appendChild(row);
          }
          return { dom };
        },
      };
    });

    const state = EditorState.create({
      doc: initialContent,
      extensions: [
        basicSetup,
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        saveKeymap,
        markdown({ codeLanguages: languages }),
        EditorView.lineWrapping,
        antiPatternLinter(),
        canonHover,
        updateListener,
        themeCompartmentRef.current.of(
          resolvedTheme === "dark" ? oneDark : [],
        ),
        readOnlyCompartmentRef.current.of(
          EditorState.readOnly.of(readOnly),
        ),
      ],
    });

    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    // When the host transitions from hidden (0×0 — e.g. its IDE pane was
    // display:none) back to visible, CodeMirror's cached geometry is stale.
    // Force a re-measure on size changes so layout and scrolling stay correct.
    const ro = new ResizeObserver(() => {
      if (hostRef.current && hostRef.current.clientWidth > 0) view.requestMeasure();
    });
    ro.observe(hostRef.current);
    return () => {
      ro.disconnect();
      view.destroy();
      viewRef.current = null;
    };
    // Mount-only; subsequent prop changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconfigure theme compartment when theme prop / class flips.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartmentRef.current.reconfigure(
        resolvedTheme === "dark" ? oneDark : [],
      ),
    });
  }, [resolvedTheme]);

  // Reconfigure read-only when prop changes.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartmentRef.current.reconfigure(
        EditorState.readOnly.of(readOnly),
      ),
    });
  }, [readOnly]);

  // Replace doc when initialContent changes (different file selected, or
  // refetch after save). Skip if doc already matches to avoid feedback.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === initialContent) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: initialContent },
    });
  }, [initialContent]);

  useImperativeHandle(
    externalRef,
    () => ({
      replaceRange: (from, to, text) => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({ changes: { from, to, insert: text } });
        view.focus();
      },
      insertAt: (pos, text) => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({
          changes: { from: pos, to: pos, insert: text },
          selection: { anchor: pos + text.length },
        });
        view.focus();
      },
      getCursor: () => {
        const view = viewRef.current;
        if (!view) return 0;
        return view.state.selection.main.head;
      },
    }),
    []
  );

  return (
    <div
      ref={hostRef}
      className="quill-md-editor border border-bg/10 dark:border-muted/20 rounded overflow-hidden"
    />
  );
});
