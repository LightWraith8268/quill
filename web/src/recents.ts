import { useEffect, useState } from "react";

export class RingStore<T> {
  private listeners = new Set<() => void>();

  constructor(
    private readonly key: string,
    private readonly max: number,
    private readonly eq: (a: T, b: T) => boolean = Object.is,
  ) {
    if (typeof window !== "undefined") {
      window.addEventListener("storage", this.handleStorage);
    }
  }

  private handleStorage = (e: StorageEvent) => {
    if (e.key === this.key) this.notify();
  };

  private read(): T[] {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(this.key);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }

  private write(items: T[]): void {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(this.key, JSON.stringify(items));
    } catch {
      // ignore quota / serialization failures
    }
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  list(): T[] {
    return this.read();
  }

  push(item: T): void {
    const current = this.read();
    const filtered = current.filter((existing) => !this.eq(existing, item));
    filtered.unshift(item);
    if (filtered.length > this.max) filtered.length = this.max;
    this.write(filtered);
    this.notify();
  }

  clear(): void {
    this.write([]);
    this.notify();
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
}

export type SearchHistoryEntry = { query: string; mode: string; ts: number };
export type RecentFileEntry = { path: string; ts: number };

export const searchHistory = new RingStore<SearchHistoryEntry>(
  "quill.searchHistory",
  30,
  (a, b) => a.query === b.query && a.mode === b.mode,
);

export const recentFiles = new RingStore<RecentFileEntry>(
  "quill.recentFiles",
  25,
  (a, b) => a.path === b.path,
);

export type RecentWorkspaceEntry = { path: string; name: string; ts: number };
export const recentWorkspaces = new RingStore<RecentWorkspaceEntry>(
  "quill.recentWorkspaces",
  12,
  (a, b) => a.path === b.path,
);

function useRingStore<T>(store: RingStore<T>): T[] {
  const [items, setItems] = useState<T[]>(() => store.list());
  useEffect(() => {
    const sync = () => setItems(store.list());
    sync();
    return store.subscribe(sync);
  }, [store]);
  return items;
}

export function useSearchHistory() {
  const entries = useRingStore(searchHistory);
  return {
    entries,
    push: (entry: SearchHistoryEntry) => searchHistory.push(entry),
    clear: () => searchHistory.clear(),
  };
}

export function useRecentFiles() {
  const entries = useRingStore(recentFiles);
  return {
    recents: entries.map((e) => e.path),
    record: (path: string) => recentFiles.push({ path, ts: Date.now() }),
    clear: () => recentFiles.clear(),
  };
}

export function useRecentWorkspaces() {
  const entries = useRingStore(recentWorkspaces);
  return {
    recents: entries,
    record: (path: string, name: string) =>
      recentWorkspaces.push({ path, name, ts: Date.now() }),
    clear: () => recentWorkspaces.clear(),
  };
}
