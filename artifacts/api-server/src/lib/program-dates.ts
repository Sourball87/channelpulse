const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
import { calendarDate, excelSerialToDate } from "./dates";
interface DateParts { month: number; day: number; year?: number }
function parts(value: string): DateParts | null {
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return { year: +iso[1], month: +iso[2] - 1, day: +iso[3] };
  const m = value.match(/^(\d{1,2})[\s/-]*([a-z]{3,9}|\d{1,2})(?:[\s,/-]+(\d{2}|\d{4}))?$/i);
  if (!m) return null;
  const month = /^\d+$/.test(m[2]) ? +m[2] - 1 : months.indexOf(m[2].slice(0, 3).toLowerCase());
  return { day: +m[1], month, ...(m[3] ? { year: +m[3] < 100 ? 2000 + +m[3] : +m[3] } : {}) };
}
function iso(p: DateParts, year: number): string | null {
  return calendarDate(p.year ?? year, p.month, p.day);
}
export function programDates(preamble: unknown[][], now = new Date()) {
  let start: DateParts | null = null, end: DateParts | null = null;
  const warnings: string[] = [];
  const dateCell = (value: unknown): DateParts | null => {
    if (typeof value === "number" && Number.isInteger(value) && value > 20000 && value < 100000) {
      const date = excelSerialToDate(value);
      return parts(date);
    }
    return parts(String(value ?? "").trim());
  };
  for (const row of preamble) {
    const label = String(row[0] ?? "").trim();
    const m = label.match(/^(start|end)(?:\s*date)?\s*[:=-]?\s*(.*)$/i);
    if (!m) continue;
    const candidates = [m[2], ...row.slice(1)].filter(v => String(v).trim());
    const parsed = candidates.map(dateCell).find((candidate): candidate is DateParts => candidate != null);
    if (!parsed) warnings.push(`Could not read ${m[1]} date "${candidates[0] ?? ""}"; enter it in the draft.`);
    else if (m[1].toLowerCase() === "start") start = parsed;
    else end = parsed;
  }
  const year = now.getUTCFullYear(), today = now.toISOString().slice(0, 10);
  const candidates = Array.from({ length: 9 }, (_, i) => year - 4 + i).map(y => {
    const s = start ? iso(start, start.year ?? y) : null;
    const endYear = end?.year ?? (s ? +s.slice(0, 4) : y);
    let e = end ? iso(end, endYear) : null;
    if (s && e && e < s && !end?.year) e = iso(end!, endYear + 1);
    const distance = s && e && s <= today && today <= e ? 0 :
      Math.min(...[s, e].filter((d): d is string => !!d).map(d => Math.abs(Date.parse(d) - Date.parse(today))));
    return { startDate: s, endDate: e, distance };
  }).sort((a, b) => a.distance - b.distance);
  const chosen = candidates[0];
  if ((start && !chosen.startDate) || (end && !chosen.endDate)) warnings.push("An invalid promotion date was left blank.");
  const inferred = (start && !start.year) || (end && !end.year);
  return {
    startDate: chosen.startDate, endDate: chosen.endDate,
    dateNote: [inferred ? `Year inferred from today's date (${today}): ${chosen.startDate ?? "start not supplied"} to ${chosen.endDate ?? "end not supplied"}. Check and correct before building the draft.` : null,
      ...warnings].filter(Boolean).join(" ") || null,
  };
}
