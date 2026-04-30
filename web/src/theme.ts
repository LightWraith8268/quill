// 3-mode theme orchestration. system | light | dark, persisted in localStorage.
// The inline script in index.html handles initial paint (no flash). This module
// exposes runtime helpers for the toggle UI and listens to system pref changes
// so "system" mode keeps in sync without a reload.

const STORAGE_KEY = "quill.theme";

export type ThemeMode = "system" | "light" | "dark";

function isThemeMode(value: string | null): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

export function getTheme(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (isThemeMode(raw)) return raw;
  } catch {
    /* noop */
  }
  return "system";
}

function prefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

export function applyTheme(): void {
  const mode = getTheme();
  const isDark = mode === "dark" || (mode === "system" && prefersDark());
  const root = document.documentElement;
  if (isDark) root.classList.add("dark");
  else root.classList.remove("dark");
}

export function setTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* noop */
  }
  applyTheme();
  // Cross-tab sync: storage event fires only in *other* tabs by default,
  // so dispatch a synthetic StorageEvent locally so the same tab's listeners
  // (e.g. the TopBar toggle) re-read state without prop drilling.
  try {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: STORAGE_KEY,
        newValue: mode,
      })
    );
  } catch {
    /* noop */
  }
}

export function subscribeSystem(cb: () => void): () => void {
  try {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => cb();
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  } catch {
    return () => {};
  }
}

// On module load, attach a system-pref listener that re-applies if mode === system.
if (typeof window !== "undefined") {
  subscribeSystem(() => {
    if (getTheme() === "system") applyTheme();
  });
}
