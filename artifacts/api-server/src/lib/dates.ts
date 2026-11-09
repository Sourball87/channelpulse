import * as XLSX from "xlsx";

export type DateOrder = "dmy" | "mdy";

const DAY_MS = 86_400_000;
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

export function isValidDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function calendarDate(year: number, monthIndex: number, dayOfMonth: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(monthIndex) || !Number.isInteger(dayOfMonth) ||
      monthIndex < 0 || monthIndex > 11 || dayOfMonth < 1 || dayOfMonth > 31) return null;
  const date = new Date(Date.UTC(year, monthIndex, dayOfMonth));
  const value = date.toISOString().slice(0, 10);
  return date.getUTCFullYear() === year && date.getUTCMonth() === monthIndex &&
    date.getUTCDate() === dayOfMonth ? value : null;
}

export function parseDateValue(value: unknown, order: DateOrder = "dmy"): string {
  if (value == null || value === "") return "";
  if (value instanceof Date)
    return Number.isFinite(value.getTime()) && isValidDateString(value.toISOString().slice(0, 10))
      ? value.toISOString().slice(0, 10) : "";
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && /^\d{8}$/.test(String(value))) {
      const digits = String(value);
      const compact = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
      return isValidDateString(compact) ? compact : "";
    }
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return "";
    const date = `${String(parsed.y).padStart(4, "0")}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
    return isValidDateString(date) ? date : "";
  }

  const text = String(value).trim();
  if (!text) return "";
  if (/^\d{8}$/.test(text)) {
    const compact = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
    return isValidDateString(compact) ? compact : "";
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return isValidDateString(text) ? text : "";
  const slash = text.match(/^(\d{1,2})[/. -](\d{1,2})[/. -](\d{2}|\d{4})(?:[ T].*)?$/);
  if (!slash) return "";
  const year = slash[3].length === 2 ? `20${slash[3]}` : slash[3];
  const month = (order === "dmy" ? slash[2] : slash[1]).padStart(2, "0");
  const day = (order === "dmy" ? slash[1] : slash[2]).padStart(2, "0");
  const date = `${year}-${month}-${day}`;
  return isValidDateString(date) ? date : "";
}

export function dateStringToWeekIso(dateString: string): string {
  if (!isValidDateString(dateString)) return "";
  const date = new Date(`${dateString}T00:00:00.000Z`);
  const isoDay = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - isoDay);
  const year = date.getUTCFullYear();
  const first = Date.UTC(year, 0, 1);
  const week = Math.ceil(((date.getTime() - first) / DAY_MS + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function isValidWeekIso(value: string): boolean {
  const match = /^(\d{4})-W(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (year < 1900 || year > 2100 || week < 1 || week > 53) return false;
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4.getTime() + ((week - 1) * 7 - ((jan4.getUTCDay() || 7) - 1)) * DAY_MS);
  return dateStringToWeekIso(monday.toISOString().slice(0, 10)) === value;
}

export function weekDates(weekIso: string): { start: string; end: string } | null {
  if (!isValidWeekIso(weekIso)) return null;
  const [yearText, weekText] = weekIso.split("-W");
  const year = Number(yearText), week = Number(weekText);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * DAY_MS + (week - 1) * 7 * DAY_MS);
  const start = monday.toISOString().slice(0, 10);
  return { start, end: new Date(monday.getTime() + 6 * DAY_MS).toISOString().slice(0, 10) };
}

export function weeksApart(left: string, right: string): number | null {
  const a = weekDates(left), b = weekDates(right);
  if (!a || !b) return null;
  return Math.round((Date.parse(`${a.start}T00:00:00.000Z`) - Date.parse(`${b.start}T00:00:00.000Z`)) / (7 * DAY_MS));
}

export function isWeekOutsideWindow(weekIso: string, referenceWeek = currentWeekIso(), weeks = 8): boolean {
  const distance = weeksApart(weekIso, referenceWeek);
  return distance == null || Math.abs(distance) > weeks;
}

export function currentWeekIso(now = new Date()): string {
  return dateStringToWeekIso(now.toISOString().slice(0, 10));
}

export function previousCompletedWeekIso(now = new Date()): string {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = today.getUTCDay() || 7;
  return dateStringToWeekIso(new Date(today.getTime() - day * DAY_MS).toISOString().slice(0, 10));
}

export function previousWeekIso(weekIso: string): string {
  const start = weekDates(weekIso)?.start;
  if (!start) return "";
  return dateStringToWeekIso(new Date(Date.parse(`${start}T00:00:00.000Z`) - DAY_MS).toISOString().slice(0, 10));
}

function fromDate(date: string) {
  if (!isValidDateString(date)) return { weekIso: null, reportDate: null };
  return { weekIso: dateStringToWeekIso(date), reportDate: date };
}

function compactDate(value: string): string | null {
  if (/^(?:19|20)\d{6}$/.test(value))
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  if (/^\d{6}$/.test(value)) {
    return `20${value.slice(0, 2)}-${value.slice(2, 4)}-${value.slice(4, 6)}`;
  }
  const dmy = /^(\d{2})(\d{2})((?:19|20)\d{2})$/.exec(value);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return null;
}

export function detectWeekFromFilename(input: string): { weekIso: string | null; reportDate: string | null } {
  const filename = input.replace(/_\d{13}(?=\.[^.]+$)/, "");
  const weekMatch = filename.match(/(?:^|[^\d])((?:19|20)\d{2})(?:[\s_.-]*[A-Z][A-Z0-9]*)?[\s_.-]*WK[\s_.-]*(\d{1,2})(?!\d)/i);
  if (weekMatch) {
    const weekIso = `${weekMatch[1]}-W${weekMatch[2].padStart(2, "0")}`;
    if (isValidWeekIso(weekIso)) return { weekIso, reportDate: null };
  }

  const isoRange = filename.match(/((?:19|20)\d{2})-(\d{1,2})-(\d{1,2})[^\d]+((?:19|20)\d{2})-(\d{1,2})-(\d{1,2})/);
  if (isoRange) {
    const date = `${isoRange[4]}-${isoRange[5].padStart(2, "0")}-${isoRange[6].padStart(2, "0")}`;
    return fromDate(date);
  }

  const dmyCompact = [...filename.matchAll(/(?:^|[^\d])(\d{8})(?!\d)/g)]
    .map(match => ({ token: match[1], date: compactDate(match[1]) }))
    .filter((item): item is { token: string; date: string } => !!item.date && isValidDateString(item.date));
  if (dmyCompact.length >= 2) return fromDate(dmyCompact.at(-1)!.date);

  const compactRange = [...filename.matchAll(/(?:^|[^\d])(\d{6})(?!\d)/g)];
  if (compactRange.length >= 2) {
    const date = compactDate(compactRange.at(-1)![1]);
    if (date && isValidDateString(date)) return fromDate(date);
  }

  const dmy = [...filename.matchAll(/(?:^|[^\d])(\d{1,2})[._/-](\d{1,2})[._/-](\d{2}|\d{4})(?!\d)/g)].at(-1);
  if (dmy) {
    const year = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    return fromDate(`${year}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`);
  }

  const compactTimestamp = filename.match(/(?:^|[^\d])((?:19|20)\d{6})\d{6}(?!\d)/);
  if (compactTimestamp) return fromDate(compactDate(compactTimestamp[1])!);

  const compactDates = [...filename.matchAll(/(?:^|[^\d])(\d{8}|\d{6})(?!\d)/g)];
  for (const match of compactDates.reverse()) {
    const date = compactDate(match[1]);
    if (date && isValidDateString(date)) return fromDate(date);
  }

  const iso = filename.match(/((?:19|20)\d{2})-(\d{1,2})-(\d{1,2})/);
  if (iso) return fromDate(`${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`);
  return { weekIso: null, reportDate: null };
}

export function mostCommonWeek(values: Iterable<unknown>, order: DateOrder = "dmy"): {
  weekIso: string | null;
  reportDate: string | null;
  datedRows: number;
  count: number;
} {
  const counts = new Map<string, { count: number; latestDate: string }>();
  for (const value of values) {
    const date = parseDateValue(value, order);
    if (!date) continue;
    const weekIso = dateStringToWeekIso(date);
    const current = counts.get(weekIso);
    counts.set(weekIso, { count: (current?.count ?? 0) + 1, latestDate: !current || date > current.latestDate ? date : current.latestDate });
  }
  const best = [...counts.entries()].sort((a, b) =>
    b[1].count - a[1].count || b[1].latestDate.localeCompare(a[1].latestDate),
  )[0];
  const datedRows = [...counts.values()].reduce((sum, item) => sum + item.count, 0);
  return best
    ? { weekIso: best[0], reportDate: best[1].latestDate, datedRows, count: best[1].count }
    : { weekIso: null, reportDate: null, datedRows: 0, count: 0 };
}

export function excelSerialToDate(value: number): string {
  if (!Number.isFinite(value) || value < 1 || value > 2958465) return "";
  const date = new Date(EXCEL_EPOCH_UTC + Math.floor(value) * DAY_MS).toISOString().slice(0, 10);
  return isValidDateString(date) ? date : "";
}
