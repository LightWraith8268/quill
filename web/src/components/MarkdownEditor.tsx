// CodeMirror 6 markdown editor for in-app editing of vault files.
// Wraps EditorView with markdown lang + line wrapping; switches to oneDark
// when dark theme is active.

import { useEffect, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { basicSetup } from "codemirror";

type Props = {
  initialContent: string;
  onChange: (content: string) => void;
  onSaveShortcut?: () => void;
  readOnly?: boolean;
  theme?: "light" | "dark";
};

export function MarkdownEditor({
  initialContent,
  onChange,
  onSaveShortcut,
  readOnly = false,
  theme,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSaveShortcut);
  const themeCompartmentRef = useRef(new Compartment());
  const readOnlyCompartmentRef = useRef(new Compartment());

  // Keep latest callbacks without re-creating the editor.
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    onSaveRef.current = onSaveShortcut;
  }, [onSaveShortcut]);

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
    ]);

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current(update.state.doc.toString());
      }
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
    return () => {
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

  return (
    <div
      ref={hostRef}
      className="quill-md-editor border border-bg/10 dark:border-muted/20 rounded overflow-hidden"
    />
  );
}
