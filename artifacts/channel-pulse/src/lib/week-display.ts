import { displayDate } from "./date-display.ts";

const DAY = 86_400_000;

/** ISO weeks start Monday; UTC calendar arithmetic avoids local-time/DST shifts. */
export function isoWeekDates(week?: string | null): { start: Date; end: Date } | undefined {
  const match = /^(\d{4})-W(\d{2})$/.exec(week ?? "");
  if (!match) return undefined;
  const year = Number(match[1]), number = Number(match[2]);
  if (year < 1000 || number < 1 || number > 53) return undefined;
  const monday = (y: number) => {
    const jan4 = new Date(Date.UTC(y, 0, 4));
    return jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * DAY;
  };
  const start = new Date(monday(year) + (number - 1) * 7 * DAY);
  if (start.getTime() >= monday(year + 1)) return undefined;
  return { start, end: new Date(start.getTime() + 6 * DAY) };
}

function calendarRange(start: Date, end: Date): string {
  return `${displayDate(start.toISOString().slice(0, 10))} – ${displayDate(end.toISOString().slice(0, 10))}`;
}

export function formatWeekRange(week?: string | null): string {
  const dates = isoWeekDates(week);
  return dates ? calendarRange(dates.start, dates.end) : "";
}

export function formatWeekLabel(week?: string | null): string {
  const range = formatWeekRange(week);
  return range ? `Week ${Number(week!.slice(6))}, ${week!.slice(0, 4)} · ${range}` : week || "Latest week";
}

export function formatWeekSpan(from?: string | null, to?: string | null): string {
  const first = isoWeekDates(from), last = isoWeekDates(to);
  if (!first || !last) return [from, to].filter(Boolean).join(" – ");
  if (from === to) return formatWeekLabel(from);
  return `${from} – ${to} · ${calendarRange(first.start, last.end)}`;
}

/** Expand ISO week tokens in server-provided display text, never in API values. */
export function formatWeekText(text: string): string {
  return text.replace(/\b\d{4}-W\d{2}\b/g, week => formatWeekLabel(week));
}
