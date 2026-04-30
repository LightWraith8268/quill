import { useRecentFiles } from "../recents.ts";

type RecentFilesProps = {
  onPick: (path: string) => void;
};

const MAX_DISPLAY = 8;
const TRUNCATE_LENGTH = 42;

function truncateHead(path: string, max = TRUNCATE_LENGTH): string {
  if (path.length <= max) return path;
  return "…" + path.slice(path.length - (max - 1));
}

export function RecentFiles({ onPick }: RecentFilesProps) {
  const { recents, clear } = useRecentFiles();
  if (recents.length === 0) return null;

  const visible = recents.slice(0, MAX_DISPLAY);

  return (
    <div className="card space-y-2">
      <div className="flex items-center gap-2">
        <h4 className="text-xs uppercase tracking-wide text-muted font-mono">
          Recent files
        </h4>
        <button
          type="button"
          onClick={clear}
          className="ml-auto text-xs text-muted hover:text-tealBright"
        >
          Clear
        </button>
      </div>
      <ul className="space-y-1">
        {visible.map((path) => {
          const fileName = path.split(/[\\/]/).pop() ?? path;
          return (
            <li key={path}>
              <button
                type="button"
                onClick={() => onPick(path)}
                title={path}
                className="w-full text-left text-sm font-mono px-2 py-1 rounded hover:bg-tealBright/10 truncate flex items-center gap-2"
              >
                <span className="truncate">{fileName}</span>
                <span className="text-xs text-muted truncate ml-auto">
                  {truncateHead(path)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
