// Per-story pin store. Active pins are prepended to the next chat turn
// as forced context. Stored in localStorage keyed by storyId.

import { useEffect, useState } from "react";

export type Pin = {
  id: string;
  kind: "search-hit" | "file";
  path: string;
  heading?: string | null;
  preview: string;
  ts: number;
};

const PIN_MAX_TOTAL_CHARS = 16_384;

const storageKey = (storyId: number): string => `quill.pins.${storyId}`;

class PinStore {
  private listeners = new Set<() => void>();
  constructor(private readonly storyId: number) {
    if (typeof window !== "undefined") {
      window.addEventListener("storage", this.onStorage);
    }
  }
  private onStorage = (e: StorageEvent): void => {
    if (e.key === storageKey(this.storyId)) this.notify();
  };
  private read(): Pin[] {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(storageKey(this.storyId));
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as Pin[]) : [];
    } catch {
      return [];
    }
  }
  private write(pins: Pin[]): void {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(storageKey(this.storyId), JSON.stringify(pins));
    } catch {
      /* ignore */
    }
  }
  private notify(): void {
    for (const cb of this.listeners) cb();
  }
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  list(): Pin[] {
    return this.read();
  }
  add(pin: Pin): void {
    const cur = this.read();
    const dup = cur.some(
      (e) =>
        e.kind === pin.kind &&
        e.path === pin.path &&
        (e.heading ?? null) === (pin.heading ?? null)
    );
    if (dup) return;
    this.write([...cur, pin]);
    this.notify();
  }
  remove(id: string): void {
    this.write(this.read().filter((p) => p.id !== id));
    this.notify();
  }
  clear(): void {
    this.write([]);
    this.notify();
  }
}

const cache = new Map<number, PinStore>();
function getStore(storyId: number): PinStore {
  let s = cache.get(storyId);
  if (!s) {
    s = new PinStore(storyId);
    cache.set(storyId, s);
  }
  return s;
}

export function addPin(storyId: number, pin: Pin): void {
  if (!storyId) return;
  getStore(storyId).add(pin);
}
export function removePin(storyId: number, id: string): void {
  if (!storyId) return;
  getStore(storyId).remove(id);
}
export function clearPins(storyId: number): void {
  if (!storyId) return;
  getStore(storyId).clear();
}
export function listPins(storyId: number): Pin[] {
  if (!storyId) return [];
  return getStore(storyId).list();
}

function buildFormat(pins: Pin[]): () => string {
  return () => {
    if (pins.length === 0) return "";
    const cap = Math.floor(PIN_MAX_TOTAL_CHARS / pins.length);
    const parts = pins.map((p) => {
      const head = p.heading ? ` [${p.heading}]` : "";
      const preview = p.preview.length > cap ? p.preview.slice(0, cap) : p.preview;
      return `## ${p.path}${head}\n${preview}`;
    });
    return `=== PINNED CONTEXT ===\n${parts.join("\n\n")}`;
  };
}

export function usePins(storyId: number): {
  pins: Pin[];
  formatForPrompt: () => string;
} {
  const [pins, setPins] = useState<Pin[]>(() =>
    storyId ? getStore(storyId).list() : []
  );
  useEffect(() => {
    if (!storyId) {
      setPins([]);
      return;
    }
    const store = getStore(storyId);
    const sync = () => setPins(store.list());
    sync();
    return store.subscribe(sync);
  }, [storyId]);
  return { pins, formatForPrompt: buildFormat(pins) };
}
