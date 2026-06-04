import { useEffect, useState, type ReactNode } from "react";
import { getTheme, setTheme, type ThemeMode } from "../theme.ts";
import { ResearchClipModal } from "./ResearchClipModal.tsx";

// Slim top bar: brand + story picker + global actions. Navigation between
// tree / editor / chat / aux views lives in the IDE shell (activity bar on
// desktop, bottom tab bar on mobile).
export function TopBar(props: {
  onLogout: () => void;
  storyPicker?: ReactNode;
}) {
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
      <div className="min-w-0 flex-1">{props.storyPicker}</div>
      <div className="flex items-center gap-2">
        <ResearchButton />
        <ThemeToggle />
        <button
          onClick={props.onLogout}
          className="btn btn-ghost text-xs"
          title="Log out"
          aria-label="Log out"
        >
          <span className="hidden sm:inline">Log out</span>
          <span className="sm:hidden" aria-hidden="true">
            ⎋
          </span>
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
        aria-label="Clip a URL into Research"
        className="px-2 py-1 text-xs rounded border border-muted/30 hover:border-tealBright hover:text-tealBright"
      >
        🔗
      </button>
      {open && (
        <ResearchClipModal onClose={() => setOpen(false)} onClipped={() => {}} />
      )}
    </>
  );
}
