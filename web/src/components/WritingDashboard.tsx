// Per-story daily-writing dashboard. Goals + last 30 days delta + sessions.

import { useEffect, useState } from "react";
import { api, type DailyWordRow, type GoalRow, type TimeSessionRow } from "../api.ts";

type Props = { storyId: number };

export function WritingDashboard({ storyId }: Props) {
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [days, setDays] = useState<DailyWordRow[]>([]);
  const [sessions, setSessions] = useState<TimeSessionRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const [g, d, s] = await Promise.all([
        api.goalsList(storyId),
        api.daylogList(storyId, 30),
        api.sessionsList(storyId, 30),
      ]);
      setGoals(g.goals);
      setDays(d.days);
      setSessions(s.sessions);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  useEffect(() => {
    refresh();
  }, [storyId]);

  const dailyTarget = goals.find((g) => g.kind === "daily_words")?.target ?? 0;
  const today = new Date().toISOString().slice(0, 10);
  const todayRow = days.find((d) => d.day === today);
  const todayDelta = todayRow?.delta ?? 0;
  const totalSeconds = sessions.reduce((s, x) => s + x.seconds, 0);

  const setGoal = async (
    kind: "daily_words" | "total_words" | "deadline",
    valueRaw: string
  ) => {
    setBusy(true);
    try {
      const val = valueRaw.trim();
      if (kind === "deadline") {
        const ms = val ? Date.parse(val) : null;
        await api.goalUpsert(storyId, { kind, deadline_ms: ms ?? null });
      } else {
        const n = val ? Number(val) : null;
        await api.goalUpsert(storyId, { kind, target: n });
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const totalGoal = goals.find((g) => g.kind === "total_words");
  const deadline = goals.find((g) => g.kind === "deadline");

  return (
    <div className="card space-y-3">
      <h3 className="font-display text-lg">Today</h3>
      {err && (
        <div className="bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200 text-xs p-2 rounded">
          {err}
        </div>
      )}
      <div className="grid grid-cols-3 gap-3 text-center">
        <Stat label="words today" value={todayDelta} />
        <Stat label={`/ daily target`} value={dailyTarget} />
        <Stat label="time today (min)" value={Math.round(totalSeconds / 60)} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <GoalInput
          label="Daily target words"
          value={String(dailyTarget || "")}
          onSave={(v) => setGoal("daily_words", v)}
          busy={busy}
        />
        <GoalInput
          label="Book target words"
          value={String(totalGoal?.target ?? "")}
          onSave={(v) => setGoal("total_words", v)}
          busy={busy}
        />
        <GoalInput
          label="Deadline (YYYY-MM-DD)"
          value={
            deadline?.deadline_ms
              ? new Date(deadline.deadline_ms).toISOString().slice(0, 10)
              : ""
          }
          onSave={(v) => setGoal("deadline", v)}
          busy={busy}
        />
      </div>

      <div>
        <h4 className="text-xs uppercase tracking-wide text-muted mb-1">Last 30 days</h4>
        {days.length === 0 && (
          <p className="text-xs text-muted">
            No daily log entries yet. POST <code>/api/stories/:id/daylog</code> with current word count to build the trend.
          </p>
        )}
        {days.length > 0 && (
          <div className="flex flex-wrap gap-1 text-xs font-mono">
            {[...days].reverse().map((d) => (
              <span
                key={d.day}
                className={`px-1.5 py-0.5 rounded ${
                  d.delta >= dailyTarget && dailyTarget > 0
                    ? "bg-emerald-500/30"
                    : d.delta > 0
                    ? "bg-tealBright/20"
                    : "bg-muted/20"
                }`}
                title={`${d.day}: +${d.delta} words (${d.words_at_end} total)`}
              >
                {d.delta > 0 ? `+${d.delta}` : "0"}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="font-display text-2xl text-tealBright">
        {value.toLocaleString()}
      </div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}

function GoalInput({
  label,
  value,
  onSave,
  busy,
}: {
  label: string;
  value: string;
  onSave: (v: string) => void;
  busy: boolean;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label className="text-xs flex flex-col gap-1">
      <span className="text-muted">{label}</span>
      <input
        className="input"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => v !== value && onSave(v)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSave(v);
        }}
        disabled={busy}
      />
    </label>
  );
}
