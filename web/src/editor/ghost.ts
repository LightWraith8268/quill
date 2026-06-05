// Ambient ghost-text: a CodeMirror extension that, when enabled, fetches a
// short canon-aware continuation after the writer pauses at the end of a line
// and renders it as gray inline text. Tab accepts, Esc dismisses, Alt-] swaps
// in an alternate. The provider is injected so this stays editor-only.

import { StateEffect, StateField, Prec } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  keymap,
} from "@codemirror/view";

export type GhostProvider = (preceding: string, variant: number) => Promise<string>;

export type GhostOptions = {
  enabled: () => boolean;
  provider: () => GhostProvider | undefined;
  debounceMs?: number;
  minContext?: number;
};

type Ghost = { from: number; text: string } | null;

const setGhost = StateEffect.define<Ghost>();
const clearGhost = StateEffect.define<null>();
// Carries a variant index to force an alternate fetch at the cursor.
const requestAlt = StateEffect.define<number>();

const ghostField = StateField.define<Ghost>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setGhost)) return e.value;
      if (e.is(clearGhost)) return null;
    }
    // Typing or any doc edit invalidates a shown ghost.
    if (tr.docChanged) return null;
    // Moving the cursor away from the ghost anchor clears it.
    if (value && tr.selection) {
      const head = tr.selection.main.head;
      if (head !== value.from || !tr.selection.main.empty) return null;
    }
    return value;
  },
});

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  override eq(o: GhostWidget): boolean {
    return o.text === this.text;
  }
  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-ghost-text";
    span.textContent = this.text;
    return span;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

const ghostDeco = EditorView.decorations.compute([ghostField], (state): DecorationSet => {
  const g = state.field(ghostField);
  if (!g || !g.text) return Decoration.none;
  return Decoration.set([
    Decoration.widget({ widget: new GhostWidget(g.text), side: 1 }).range(g.from),
  ]);
});

const ghostTheme = EditorView.baseTheme({
  ".cm-ghost-text": {
    opacity: "0.42",
    fontStyle: "italic",
  },
});

export function ambientGhost(opts: GhostOptions) {
  const debounceMs = opts.debounceMs ?? 700;
  const minContext = opts.minContext ?? 1;

  const fetchPlugin = ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | null = null;
      reqId = 0;
      constructor(readonly view: EditorView) {}

      update(u: ViewUpdate): void {
        for (const tr of u.transactions) {
          for (const e of tr.effects) {
            if (e.is(requestAlt)) {
              void this.fetch(e.value);
              return;
            }
          }
        }
        if (!opts.enabled()) {
          if (this.timer) clearTimeout(this.timer);
          if (u.view.state.field(ghostField, false)) {
            u.view.dispatch({ effects: clearGhost.of(null) });
          }
          return;
        }
        if (u.docChanged || u.selectionSet) this.schedule();
      }

      schedule(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.fetch(0), debounceMs);
      }

      async fetch(variant: number): Promise<void> {
        const provider = opts.provider();
        if (!provider || !opts.enabled()) return;
        const state = this.view.state;
        const sel = state.selection.main;
        if (!sel.empty) return;
        const pos = sel.from;
        const line = state.doc.lineAt(pos);
        if (pos !== line.to) return; // only at end of line
        if (line.text.trim().length < minContext) return;
        const preceding = state.doc.sliceString(Math.max(0, pos - 1500), pos);
        const myId = ++this.reqId;
        let text = "";
        try {
          text = await provider(preceding, variant);
        } catch {
          return;
        }
        if (myId !== this.reqId) return; // superseded
        text = text.trim();
        if (!text) return;
        const cur = this.view.state.selection.main;
        if (!cur.empty || cur.from !== pos) return; // cursor moved while fetching
        this.view.dispatch({ effects: setGhost.of({ from: pos, text }) });
      }

      destroy(): void {
        if (this.timer) clearTimeout(this.timer);
      }
    }
  );

  const accept = (view: EditorView): boolean => {
    const g = view.state.field(ghostField, false);
    if (!g || !g.text) return false;
    view.dispatch({
      changes: { from: g.from, to: g.from, insert: g.text },
      selection: { anchor: g.from + g.text.length },
      effects: clearGhost.of(null),
    });
    return true;
  };

  const dismiss = (view: EditorView): boolean => {
    if (!view.state.field(ghostField, false)) return false;
    view.dispatch({ effects: clearGhost.of(null) });
    return true;
  };

  let altCounter = 1;
  const alternate = (view: EditorView): boolean => {
    if (!opts.enabled()) return false;
    view.dispatch({ effects: [clearGhost.of(null), requestAlt.of(altCounter++)] });
    return true;
  };

  const ghostKeymap = Prec.highest(
    keymap.of([
      { key: "Tab", run: accept },
      { key: "Escape", run: dismiss },
      { key: "Alt-]", run: alternate },
    ])
  );

  return [ghostField, ghostDeco, ghostTheme, fetchPlugin, ghostKeymap];
}
