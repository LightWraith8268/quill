import { useEffect, useState, type ReactNode } from "react";
import { getTheme, setTheme, type ThemeMode } from "../theme.ts";
import { ResearchClipModal } from "./ResearchClipModal.tsx";

type Tab =
  | "chat"
  | "outline"
  | "workflows"
  | "search"
  | "vault"
  | "lore"
  | "characters"
  | "styles"
  | "stats";

export function TopBar(props: {
  tab: Tab;
  setTab: (t: Tab) => void;
  onLogout: () => void;
  storyPicker?: ReactNode;
}) {
  const tabs: { id: Tab; label: string }[] = [
    { id: "chat", label: "Chat" },
    { id: "outline", label: "Outline" },
    { id: "workflows", label: "Workflows" },
    { id: "search", label: "Search" },
    { id: "vault", label: "Vault" },
    { id: "lore", label: "Lore" },
    { id: "characters", label: "Characters" },
    { id: "styles", label: "Styles" },
    { id: "stats", label: "Stats" },
  ];
  const [menuOpen, setMenuOpen] = useState(false);
  const activeLabel = tabs.find((t) => t.id === props.tab)?.label ?? "Menu";

  return (
    <header className="border-b border-bg/10 dark:border-muted/20 px-3 sm:px-4 py-2 sm:py-3 flex items-center gap-2 sm:gap-4">
      <div className="font-display text-lg sm:text-xl whitespace-nowrap">
        <span className="hidden sm:inline">
          Quill <span className="italic text-tealBright">&</span> the Vault
        </span>
        <span className="sm:hidden">
          Q<span className="italic text-tealBright">&</span>V
        </span>
      </div>
      <div className="min-w-0 flex-1 sm:flex-initial">{props.storyPicker}</div>
      <nav className="hidden sm:flex gap-1 ml-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => props.setTab(t.id)}
            className={`btn ${props.tab === t.id ? "btn-primary" : "btn-ghost"}`}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <ResearchButton />
        <ThemeToggle />
        <button
          onClick={props.onLogout}
          className="hidden sm:inline-flex btn btn-ghost text-xs"
        >
          Log out
        </button>
        <button
          onClick={() => setMenuOpen(true)}
          aria-label="Open menu"
          className="sm:hidden btn btn-ghost px-2 py-1.5"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
      </div>

      {menuOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
          className="fixed inset-0 z-50 bg-paper dark:bg-bg flex flex-col sm:hidden"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-bg/10 dark:border-muted/20">
            <span className="font-display text-lg">{activeLabel}</span>
            <button
              onClick={() => setMenuOpen(false)}
              aria-label="Close menu"
              className="btn btn-ghost px-2 py-1.5"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <nav className="flex-1 overflow-auto p-3 space-y-1">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  props.setTab(t.id);
                  setMenuOpen(false);
                }}
                className={`w-full text-left btn ${
                  props.tab === t.id ? "btn-primary" : "btn-ghost"
                } text-base py-3`}
              >
                {t.label}
              </button>
            ))}
            <button
              onClick={() => {
                setMenuOpen(false);
                props.onLogout();
              }}
              className="w-full text-left btn btn-ghost text-base py-3 mt-4"
            >
              Log out
            </button>
          </nav>
        </div>
      )}
    </header>
  );
}

function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>(getTheme);

  useEffect(() => {
    const sync = () => setMode(getTheme());
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const options: { id: ThemeMode; label: string; title: string }[] = [
    { id: "system", label: "Sys", title: "Match system theme" },
    { id: "light", label: "Lgt", title: "Light theme" },
    { id: "dark", label: "Drk", title: "Dark theme" },
  ];

  const pick = (next: ThemeMode) => {
    setTheme(next);
    setMode(next);
  };

  return (
    <div
      role="group"
      aria-label="Theme"
      className="inline-flex rounded border border-bg/30 dark:border-muted/30 overflow-hidden text-xs"
    >
      {options.map((o) => {
        const active = mode === o.id;
        return (
          <button
            key={o.id}
            onClick={() => pick(o.id)}
            title={o.title}
            aria-pressed={active}
            className={`px-2 py-1 transition-colors ${
              active
                ? "bg-teal text-paper"
                : "bg-transparent text-bg dark:text-paper hover:bg-bg/10 dark:hover:bg-muted/10"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function ResearchButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Clip a URL into Research/"
        className="px-2 py-1 text-xs rounded border border-muted/30 hover:border-tealBright hover:text-tealBright"
      >
        🔗
      </button>
      {open && (
        <ResearchClipModal
          onClose={() => setOpen(false)}
          onClipped={() => {}}
        />
      )}
    </>
  );
}
