import { useCallback, useEffect, useState } from "react";
import { METRIC_STORAGE_KEY, parseStoredMetrics, type StockMetric } from "@/lib/metric-selection";

function read(): StockMetric[] {
  try {
    return parseStoredMetrics(typeof window === "undefined" ? null : window.localStorage.getItem(METRIC_STORAGE_KEY));
  } catch {
    return parseStoredMetrics(null);
  }
}

/** Selected metric columns, persisted locally; independent of filters/category/week. */
export function useStockMetrics() {
  const [metrics, setMetricsState] = useState<StockMetric[]>(read);

  useEffect(() => {
    try { window.localStorage.setItem(METRIC_STORAGE_KEY, JSON.stringify(metrics)); } catch { /* storage unavailable */ }
  }, [metrics]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (e.key === METRIC_STORAGE_KEY) setMetricsState(read()); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const update = useCallback((fn: (prev: StockMetric[]) => StockMetric[]) => setMetricsState(fn), []);
  return { metrics, update };
}
