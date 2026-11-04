export type StockMetric = "st" | "soh";

export const ALL_METRICS: readonly StockMetric[] = ["st", "soh"];
export const DEFAULT_METRICS: StockMetric[] = ["st", "soh"];
export const METRIC_STORAGE_KEY = "channelpulse.stockMetrics.v1";

export const METRIC_PRESETS: { id: string; label: string; metrics: StockMetric[] }[] = [
  { id: "combined", label: "Combined", metrics: ["st", "soh"] },
  { id: "st", label: "ST only", metrics: ["st"] },
  { id: "soh", label: "SOH only", metrics: ["soh"] },
];

export const METRIC_INFO: Record<StockMetric, { short: string; long: string; unit: string }> = {
  st: { short: "ST", long: "Sell Through", unit: "units sold" },
  soh: { short: "SOH", long: "Stock on Hand", unit: "units on hand" },
};

export function isStockMetric(value: unknown): value is StockMetric {
  return value === "st" || value === "soh";
}

/** Keep only known metrics, first occurrence wins. Non-arrays yield null. */
export function sanitizeMetrics(value: unknown): StockMetric[] | null {
  if (!Array.isArray(value)) return null;
  const out: StockMetric[] = [];
  for (const item of value) if (isStockMetric(item) && !out.includes(item)) out.push(item);
  return out;
}

/** Add idempotently; optional index inserts at position (clamped). */
export function addMetric(list: StockMetric[], metric: StockMetric, index?: number): StockMetric[] {
  if (!isStockMetric(metric) || list.includes(metric)) return list;
  const next = [...list];
  const at = index === undefined ? next.length : Math.max(0, Math.min(next.length, index));
  next.splice(at, 0, metric);
  return next;
}

export function removeMetric(list: StockMetric[], metric: StockMetric): StockMetric[] {
  return list.includes(metric) ? list.filter(m => m !== metric) : list;
}

/** Move a metric to a target index within the list (clamped). */
export function moveMetric(list: StockMetric[], metric: StockMetric, toIndex: number): StockMetric[] {
  const from = list.indexOf(metric);
  if (from < 0) return list;
  const next = list.filter(m => m !== metric);
  const at = Math.max(0, Math.min(next.length, toIndex));
  next.splice(at, 0, metric);
  return next.every((m, i) => m === list[i]) ? list : next;
}

/** Parse stored JSON; invalid/missing falls back to default. A saved empty list is respected. */
export function parseStoredMetrics(raw: string | null | undefined): StockMetric[] {
  if (raw == null) return [...DEFAULT_METRICS];
  try {
    const value = JSON.parse(raw);
    const parsed = sanitizeMetrics(value);
    if (Array.isArray(value) && value.length > 0 && parsed?.length === 0) return [...DEFAULT_METRICS];
    return parsed ?? [...DEFAULT_METRICS];
  } catch {
    return [...DEFAULT_METRICS];
  }
}

export function sameMetrics(a: readonly StockMetric[], b: readonly StockMetric[]): boolean {
  return a.length === b.length && a.every((m, i) => m === b[i]);
}
