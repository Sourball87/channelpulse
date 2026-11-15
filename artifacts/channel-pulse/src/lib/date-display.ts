const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const calendarFormatter = new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", day: "2-digit", month: "numeric", year: "numeric" });
const sydneyFormatter = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", day: "2-digit", month: "numeric", year: "numeric" });
const timeFormatter = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", hour: "2-digit", minute: "2-digit" });

/** Calendar dates never shift with the browser's timezone; timestamps use Sydney time. */
export function displayDate(value: string | null | undefined): string {
  if (!value) return "";
  const calendar = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(calendar ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime()) || (calendar && date.toISOString().slice(0, 10) !== value)) return value;
  const parts = (calendar ? calendarFormatter : sydneyFormatter).formatToParts(date);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part("day")} ${months[Number(part("month")) - 1]} ${part("year")}`;
}

export function displayDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${displayDate(value)}, ${timeFormatter.format(date)} Sydney`;
}
