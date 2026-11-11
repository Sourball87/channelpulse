import { formatWeekLabel, formatWeekSpan } from "@/lib/week-display";
import { createContext, useContext, useCallback, useMemo } from "react";
import { useLocation, useSearch } from "wouter";
import { useGetAvailableWeeks } from "@workspace/api-client-react";
import { trackEvent } from "@/lib/analytics";
import { readCategoryFilter, writeCategoryFilter } from "@/lib/category-filtering";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FilterApiParams {
  week_iso?: string;
  week_from?: string;
  week_to?: string;
  part_ids?: string;
  reseller_ids?: string;
}

interface FilterContextValue {
  // Raw URL state
  partIds: number[];
  resellerIds: number[];
  category?: string;
  preset?: string;          // "last4" | "last8" | "last12" | "mtd" | "qtd" | "ytd" | "custom"
  weekFrom?: string;        // explicit custom range
  weekTo?: string;
  weekIso?: string;         // explicit single week
  mode: "week" | "period";

  // Resolved (preset → dates)
  resolvedFrom?: string;
  resolvedTo?: string;
  resolvedWeek?: string;    // effective single week (latest if nothing set)

  // Ready-to-use params for API calls
  apiParams: FilterApiParams;

  // Reference week for insight API calls (single point-in-time)
  insightWeek?: string;

  // Display helpers
  periodLabel: string;
  isFiltered: boolean;
  focusView: boolean;

  // Actions
  setFilters: (updates: Partial<{
    partIds: number[];
    resellerIds: number[];
    category?: string | null;
    weekIso?: string;
    preset?: string;
    weekFrom?: string;
    weekTo?: string;
    clearDate?: boolean;
  }>) => void;
  clearFilters: () => void;

  // Available weeks for pickers (newest-first)
  availableWeeks: string[];
}

// ── Context ───────────────────────────────────────────────────────────────────

const FilterContext = createContext<FilterContextValue>({
  partIds: [], resellerIds: [], mode: "week",
  apiParams: {}, periodLabel: "Latest", isFiltered: false,
  focusView: false,
  setFilters: () => {}, clearFilters: () => {}, availableWeeks: [],
});

// ── Preset resolution ─────────────────────────────────────────────────────────

function resolvePreset(
  preset: string,
  weeks: string[],
): { from?: string; to?: string } {
  if (!weeks.length) return {};
  const sorted = [...weeks].sort((a, b) => b.localeCompare(a)); // newest-first
  const n = sorted.length;

  switch (preset) {
    case "last4":  return { from: sorted[Math.min(3, n - 1)],  to: sorted[0] };
    case "last8":  return { from: sorted[Math.min(7, n - 1)],  to: sorted[0] };
    case "last12": return { from: sorted[Math.min(11, n - 1)], to: sorted[0] };
    case "mtd": {
      const latest = sorted[0];
      const [year, wkStr] = latest.split("-W");
      const wk = parseInt(wkStr, 10);
      // Approximate MTD: weeks whose week number falls in the same ~4-week block
      const startWk = Math.floor((wk - 1) / 4) * 4 + 1;
      const mtdWeeks = sorted.filter(w => {
        const [wy, wws] = w.split("-W");
        return wy === year && parseInt(wws, 10) >= startWk;
      });
      return { from: mtdWeeks[mtdWeeks.length - 1], to: mtdWeeks[0] };
    }
    case "qtd": {
      const latest = sorted[0];
      const [year, wkStr] = latest.split("-W");
      const wk = parseInt(wkStr, 10);
      const qStart = Math.floor((wk - 1) / 13) * 13 + 1;
      const qtdWeeks = sorted.filter(w => {
        const [wy, wws] = w.split("-W");
        return wy === year && parseInt(wws, 10) >= qStart;
      });
      return { from: qtdWeeks[qtdWeeks.length - 1], to: qtdWeeks[0] };
    }
    case "ytd": {
      const [year] = sorted[0].split("-W");
      const ytdWeeks = sorted.filter(w => w.startsWith(`${year}-W`));
      return { from: ytdWeeks[ytdWeeks.length - 1], to: ytdWeeks[0] };
    }
    default: return {};
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function FilterProvider({ children }: { children: React.ReactNode }) {
  const search = useSearch();
  const [location, navigate] = useLocation();
  const { data: weeksData } = useGetAvailableWeeks();

  const availableWeeks = useMemo(
    () => (weeksData ?? []).map(w => w.week_iso).filter(Boolean).sort((a, b) => b!.localeCompare(a!)) as string[],
    [weeksData],
  );

  // Parse URL → filter state
  const params = useMemo(() => new URLSearchParams(search), [search]);

  const partIds    = useMemo(() => params.get("parts")?.split(",").map(Number).filter(n => n > 0) ?? [], [params]);
  const resellerIds = useMemo(() => params.get("resellers")?.split(",").map(Number).filter(n => n > 0) ?? [], [params]);
  const category = readCategoryFilter(search);
  const preset     = params.get("period") ?? undefined;
  const weekFrom   = params.get("from") ?? undefined;
  const weekTo     = params.get("to") ?? undefined;
  const weekIso    = params.get("week") ?? undefined;
  const focusView = location === "/explorer" || location === "/sell-through";

  const mode: "week" | "period" = preset != null || (weekFrom != null && weekTo != null) ? "period" : "week";

  // Resolve preset → actual from/to dates
  const { resolvedFrom, resolvedTo } = useMemo(() => {
    if (weekFrom && weekTo) return { resolvedFrom: weekFrom, resolvedTo: weekTo };
    if (preset && preset !== "custom" && availableWeeks.length > 0) {
      const r = resolvePreset(preset, availableWeeks);
      return { resolvedFrom: r.from, resolvedTo: r.to };
    }
    return {};
  }, [preset, weekFrom, weekTo, availableWeeks]);

  // Effective single week
  const resolvedWeek = weekIso ?? availableWeeks[0];

  // API params for all queries
  const apiParams = useMemo<FilterApiParams>(() => {
    const p: FilterApiParams = {};
    if (partIds.length > 0) p.part_ids = partIds.join(",");
    if (resellerIds.length > 0) p.reseller_ids = resellerIds.join(",");
    if (mode === "period" && resolvedFrom && resolvedTo) {
      p.week_from = resolvedFrom;
      p.week_to = resolvedTo;
    } else {
      if (resolvedWeek) p.week_iso = resolvedWeek;
    }
    return p;
  }, [partIds, resellerIds, mode, resolvedFrom, resolvedTo, resolvedWeek]);

  // Reference week for insight calls (latest week of period, or single week)
  const insightWeek = mode === "period" ? resolvedTo : resolvedWeek;

  // Period label for display
  const periodLabel = useMemo(() => {
    if (mode === "week") return formatWeekLabel(resolvedWeek);
    const LABELS: Record<string, string> = {
      last4: "Last 4 weeks", last8: "Last 8 weeks", last12: "Last 12 weeks",
      mtd: "Month to date", qtd: "Quarter to date", ytd: "Year to date",
    };
    if (preset && LABELS[preset]) return `${LABELS[preset]}${resolvedFrom && resolvedTo ? ` · ${formatWeekSpan(resolvedFrom, resolvedTo)}` : ""}`;
    if (resolvedFrom && resolvedTo) {
      // e.g. "W20 – W27"
      return formatWeekSpan(resolvedFrom, resolvedTo);
    }
    return "Period";
  }, [mode, preset, resolvedFrom, resolvedTo, resolvedWeek]);

  const isFiltered = partIds.length > 0 || resellerIds.length > 0 || !!category || !!weekIso || !!weekFrom || preset != null;

  // Update URL
  const setFilters = useCallback((updates: Partial<{
    partIds: number[];
    resellerIds: number[];
    category?: string | null;
    weekIso?: string;
    preset?: string;
    weekFrom?: string;
    weekTo?: string;
    clearDate?: boolean;
  }>) => {
    const p = new URLSearchParams(search);

    if ("partIds" in updates) {
      const ids = updates.partIds!;
      if (ids.length > 0) p.set("parts", ids.join(",")); else p.delete("parts");
    }
    if ("resellerIds" in updates) {
      const ids = updates.resellerIds!;
      if (ids.length > 0) p.set("resellers", ids.join(",")); else p.delete("resellers");
    }
    if ("category" in updates) writeCategoryFilter(p, updates.category);
    if ("weekIso" in updates) {
      if (updates.weekIso) { p.set("week", updates.weekIso); p.delete("period"); p.delete("from"); p.delete("to"); }
      else p.delete("week");
    }
    if ("preset" in updates) {
      if (updates.preset) { p.set("period", updates.preset); p.delete("week"); p.delete("from"); p.delete("to"); }
      else { p.delete("period"); }
    }
    if ("weekFrom" in updates || "weekTo" in updates) {
      const from = updates.weekFrom ?? (p.get("from") ?? undefined);
      const to   = updates.weekTo   ?? (p.get("to")   ?? undefined);
      if (from) p.set("from", from); else p.delete("from");
      if (to)   p.set("to", to);     else p.delete("to");
      p.delete("period"); p.delete("week");
    }
    if (updates.clearDate) {
      p.delete("week"); p.delete("period"); p.delete("from"); p.delete("to");
    }

    const qs = p.toString();
    if (qs !== new URLSearchParams(search).toString()) {
      trackEvent("filters_changed", {
        page: location,
        accounts_changed: "resellerIds" in updates,
        stock_changed: "partIds" in updates,
        date_changed: "weekIso" in updates || "preset" in updates ||
          "weekFrom" in updates || "weekTo" in updates || !!updates.clearDate,
        category_changed: "category" in updates,
        account_count: p.get("resellers")?.split(",").filter(Boolean).length ?? 0,
        sku_count: p.get("parts")?.split(",").filter(Boolean).length ?? 0,
        mode: p.has("period") || p.has("from") ? "period" : "week",
      });
    }
    navigate(`${location}${qs ? "?" + qs : ""}`);
  }, [search, location, navigate]);

  const clearFilters = useCallback(() => {
    if (search) trackEvent("filters_reset", { page: location });
    navigate(location);
  }, [location, navigate, search]);

  const value: FilterContextValue = {
    partIds, resellerIds, category, preset, weekFrom, weekTo, weekIso,
    mode, resolvedFrom, resolvedTo, resolvedWeek,
    apiParams, insightWeek,
    periodLabel, isFiltered, focusView,
    setFilters, clearFilters, availableWeeks,
  };

  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}

export function useFilters() {
  return useContext(FilterContext);
}
