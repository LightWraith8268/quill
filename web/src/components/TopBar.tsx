import type { ReactNode } from "react";

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
    <header className="border-b border-muted/20 px-4 py-3 flex items-center gap-4">
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
      <div className="ml-auto">
        <button onClick={props.onLogout} className="btn btn-ghost text-xs">
          Log out
        </button>
      </div>
    </header>
  );
}
