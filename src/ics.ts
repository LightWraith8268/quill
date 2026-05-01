// Build a single .ics file from a story's goals + (optional) daily reminders.

import { listGoals } from "./dashboard.ts";
import { getStory } from "./stories.ts";
import type { DB } from "./db.ts";

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}
function fmtICS(d: Date): string {
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

export function buildIcsForStory(
  db: DB,
  storyId: number,
  opts: { includeDaily?: boolean; dailyHour?: number; dailyMinute?: number } = {}
): { filename: string; payload: string } {
  const story = getStory(db, storyId);
  if (!story) throw new Error("story not found");
  const goals = listGoals(db, storyId);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//InkNIron Apps//Quill//EN",
    "METHOD:PUBLISH",
  ];
  const now = new Date();
  let uidCounter = 0;
  const uid = (): string =>
    `${now.getTime()}-${storyId}-${uidCounter++}@quill.local`;

  // Deadline as a single all-day event
  const deadline = goals.find((g) => g.kind === "deadline");
  if (deadline?.deadline_ms) {
    const d = new Date(deadline.deadline_ms);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${uid()}`,
      `DTSTAMP:${fmtICS(now)}`,
      `DTSTART;VALUE=DATE:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`,
      `SUMMARY:Quill deadline — ${story.name}`,
      `DESCRIPTION:Manuscript deadline for ${story.name}`,
      "END:VEVENT"
    );
  }

  // Daily reminder for next 90 days
  if (opts.includeDaily ?? true) {
    const hour = opts.dailyHour ?? 8;
    const minute = opts.dailyMinute ?? 0;
    for (let i = 0; i < 90; i++) {
      const start = new Date();
      start.setUTCDate(start.getUTCDate() + i);
      start.setUTCHours(hour, minute, 0, 0);
      const end = new Date(start.getTime() + 60 * 60 * 1000);
      const dailyTarget = goals.find((g) => g.kind === "daily_words")?.target;
      lines.push(
        "BEGIN:VEVENT",
        `UID:${uid()}`,
        `DTSTAMP:${fmtICS(now)}`,
        `DTSTART:${fmtICS(start)}`,
        `DTEND:${fmtICS(end)}`,
        `SUMMARY:Write ${story.name}${dailyTarget ? ` (${dailyTarget}w)` : ""}`,
        "END:VEVENT"
      );
    }
  }

  lines.push("END:VCALENDAR");
  const slug = story.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return {
    filename: `${slug}-quill.ics`,
    payload: lines.join("\r\n") + "\r\n",
  };
}
