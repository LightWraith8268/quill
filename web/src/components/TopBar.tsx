import { useEffect, useState, type ReactNode } from "react";
import { getTheme, setTheme, type ThemeMode } from "../theme.ts";

type Tab = "chat" | "workflows" | "search" | "vault" | "lore" | "styles" | "stats";

export function TopBar(props: {
  tab: Tab;
  setTab: (t: Tab) => void;
  onLogout: () => void;
  storyPicker?: ReactNode;
}) {
  const tabs: { id: Tab; label: string }[] = [
    { id: "chat", label: "Chat" },
    { id: "workflows", label: "Workflows" },
    { id: "search", label: "Search" },
    { id: "vault", label: "Vault" },
    { id: "lore", label: "Lore" },
    { id: "styles", label: "Styles" },
    { id: "stats", label: "Stats" },
  ];
  return (
    <header className="border-b border-bg/10 dark:border-muted/20 px-4 py-3 flex items-center gap-4">
      <div className="font-display text-xl whitespace-nowrap">
        Quill <span className="italic text-tealBright">&</span> the Vault
      </div>
      {props.storyPicker}
      <nav className="flex gap-1 ml-2">
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
        <ThemeToggle />
        <button onClick={props.onLogout} className="btn btn-ghost text-xs">
          Log out
        </button>
      </div>
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
    { id: "light", label: "Light", title: "Light theme" },
    { id: "dark", label: "Dark", title: "Dark theme" },
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
