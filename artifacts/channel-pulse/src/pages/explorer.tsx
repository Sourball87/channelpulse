import { useMemo, useState } from "react";
import {
  exportExplorerView,
  getGetExplorerAnalyticsQueryKey,
  useGetExplorerAnalytics,
  useGetParts,
} from "@workspace/api-client-react";
import type { ExplorerAnalyticsRow } from "@workspace/api-client-react";
import { useFilters } from "@/context/filter-context";
import { customerLabel } from "@/lib/customer-display";
import { formatWeekLabel } from "@/lib/week-display";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertCircle, ChevronRight, Download, RotateCcw, TableProperties } from "lucide-react";

type Dimension = "Category" | "SKU" | "Customer" | "Week";
type Measure = "Sold" | "SOH" | "WOI" | "Serials reported" | "DD sell-in";
type DrillEntry = { dimension: Dimension; key: string; label: string };
type GroupedRow = {
  key: string;
  label: string;
  dimension: Dimension;
  values: Record<Measure, number | null>;
  woiState: string | null;
  sourceRows: ExplorerAnalyticsRow[];
  drill?: DrillEntry;
};

const DIMENSION_ORDER: Dimension[] = ["Category", "SKU", "Customer", "Week"];
const MEASURE_KEYS: Record<Measure, keyof ExplorerAnalyticsRow | "woi"> = {
  Sold: "sold",
  SOH: "soh",
  WOI: "woi",
  "Serials reported": "serials_reported",
  "DD sell-in": "dd_sell_in",
};
const DIMENSION_LABELS: Record<Dimension, string> = {
  Category: "Category",
  SKU: "Stock code",
  Customer: "Customer",
  Week: "Week",
};

function groupField(dimension: Dimension, row: ExplorerAnalyticsRow): string {
  if (dimension === "Category") return row.category;
  if (dimension === "SKU") return String(row.part_id ?? row.part_no);
  if (dimension === "Customer") return String(row.reseller_id);
  return row.week_iso;
}

function groupLabel(dimension: Dimension, row: ExplorerAnalyticsRow): string {
  if (dimension === "Category") return row.category || "Uncategorized";
  if (dimension === "SKU") return row.part_no;
  if (dimension === "Customer") return customerLabel(row.reseller_code);
  return formatWeekLabel(row.week_iso);
}

function latestRows(rows: ExplorerAnalyticsRow[]): ExplorerAnalyticsRow[] {
  const latestWeek = rows.reduce((latest, row) => row.week_iso > latest ? row.week_iso : latest, "");
  return rows.filter((row) => row.week_iso === latestWeek);
}

function aggregate(rows: ExplorerAnalyticsRow[]): GroupedRow["values"] & { woiState: string | null } {
  const sum = (key: "sold" | "serials_reported" | "dd_sell_in") => {
    const values = rows.map((row) => row[key]).filter((value): value is number => value != null);
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  const latest = latestRows(rows);
  const sohValues = latest.map((row) => row.soh).filter((value): value is number => value != null);
  const averageValues = latest.map((row) => row.avg_weekly_sold).filter((value): value is number => value != null);
  const soh = sohValues.length ? sohValues.reduce((total, value) => total + value, 0) : null;
  const average = averageValues.length ? averageValues.reduce((total, value) => total + value, 0) : null;
  const rowWoi = latest.find((row) => row.woi != null);
  const woi = average != null && average > 0 && soh != null ? soh / average : rowWoi?.woi ?? null;
  const woiState = woi != null ? "value" : latest.find((row) => row.woi_state)?.woi_state ?? null;
  return {
    Sold: sum("sold"),
    SOH: soh,
    WOI: woi,
    "Serials reported": sum("serials_reported"),
    "DD sell-in": sum("dd_sell_in"),
    woiState,
  };
}

function formatValue(value: number | null, measure: Measure, woiState: string | null): string {
  if (value != null) return measure === "WOI" ? value.toFixed(1) : value.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (measure === "WOI" && woiState === "no_sales") return "No sales";
  return "—";
}

export default function Explorer() {
  const { apiParams } = useFilters();
  const [category, setCategory] = useState("All");
  const [woiWeeks, setWoiWeeks] = useState<4 | 8 | 13>(4);
  const [dimensions, setDimensions] = useState<Dimension[]>(["Category", "SKU", "Customer"]);
  const [measures, setMeasures] = useState<Measure[]>(["Sold", "SOH", "WOI"]);
  const [path, setPath] = useState<DrillEntry[]>([]);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const { data: parts = [] } = useGetParts();
  const queryCategory = category === "All" ? undefined : category;
  const params = {
    ...apiParams,
    category: queryCategory,
    woi_weeks: woiWeeks,
  };
  const {
    data,
    isLoading,
    isError,
    refetch,
  } = useGetExplorerAnalytics(params, { query: { queryKey: getGetExplorerAnalyticsQueryKey(params) } });

  const categoryOptions = useMemo(() => {
    const fromParts = parts.filter((part) => part.active !== false).map((part) => part.category).filter((value) => value && value !== "HDD & Memory");
    return ["All", ...Array.from(new Set(fromParts)).sort((a, b) => a.localeCompare(b))];
  }, [parts]);
  const availableDimensions: Dimension[] = dimensions.length ? dimensions : ["Category"];
  const currentDimension: Dimension = availableDimensions[Math.min(path.length, availableDimensions.length - 1)] ?? "Category";
  const filteredRows = useMemo(() => {
    let rows = data?.rows ?? [];
    for (const entry of path) rows = rows.filter((row) => groupField(entry.dimension, row) === entry.key);
    return rows;
  }, [data, path]);

  const visibleRows = useMemo(() => {
    if (!filteredRows.length || !currentDimension) return [];
    const buckets = new Map<string, ExplorerAnalyticsRow[]>();
    for (const row of filteredRows) {
      const key = groupField(currentDimension, row);
      const bucket = buckets.get(key) ?? [];
      bucket.push(row);
      buckets.set(key, bucket);
    }
    return Array.from(buckets.entries()).map(([key, rows]) => {
      const representative = rows[0];
      const metrics = aggregate(rows);
      const label = groupLabel(currentDimension, representative);
      const nextDimension = availableDimensions[path.length + 1];
      const hasNext = Boolean(nextDimension);
      return {
        key,
        label,
        dimension: currentDimension,
        values: metrics,
        woiState: metrics.woiState,
        sourceRows: rows,
        drill: hasNext ? { dimension: currentDimension, key, label } : undefined,
      } satisfies GroupedRow;
    }).sort((a, b) => {
      if (currentDimension === "Week") return a.key.localeCompare(b.key);
      return a.label.localeCompare(b.label, undefined, { numeric: true });
    });
  }, [filteredRows, currentDimension, availableDimensions, path.length]);

  const toggleDimension = (dimension: Dimension) => {
    setDimensions((current) => {
      const next = current.includes(dimension) ? current.filter((item) => item !== dimension) : [...current, dimension];
      const ordered = DIMENSION_ORDER.filter((item) => next.includes(item));
      setPath([]);
      return ordered.length ? ordered : ["Category"];
    });
  };
  const toggleMeasure = (measure: Measure) => {
    setMeasures((current) => current.includes(measure) ? current.filter((item) => item !== measure) : [...current, measure]);
  };
  const resetDrill = () => setPath([]);
  const drillInto = (row: GroupedRow) => {
    if (row.drill) setPath((current) => [...current.slice(0, path.length), row.drill!]);
  };

  const exportRows = async () => {
    setExporting(true);
    setExportError("");
    const columns = [...availableDimensions.slice(0, path.length).map((dimension) => DIMENSION_LABELS[dimension]), DIMENSION_LABELS[currentDimension], ...measures];
    const rows = visibleRows.map((row) => {
      const drillValues = path.map((entry) => entry.label);
      const dimensionValue = row.dimension === "Customer" ? row.label : row.dimension === "Week" ? row.key : row.label;
      return [...drillValues, dimensionValue, ...measures.map((measure) => row.values[measure])];
    });
    try {
      const blob = await exportExplorerView({ columns, rows });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = "channelpulse-explorer.xlsx";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Export could not be completed.");
    } finally {
      setExporting(false);
    }
  };

  const hasRows = visibleRows.length > 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-muted/20">
      <header className="flex-none border-b bg-background px-4 py-4 md:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <TableProperties className="h-5 w-5 text-primary" />
              <h1 className="text-2xl font-semibold tracking-tight">Explorer</h1>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">Reconcile sell-through, inventory and distributor sell-in by dimension.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={category} onValueChange={(next) => { setCategory(next); setPath([]); }}>
              <SelectTrigger className="w-[170px]" aria-label="Filter Explorer by category" data-testid="select-explorer-category"><SelectValue placeholder="Category" /></SelectTrigger>
              <SelectContent>{categoryOptions.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={String(woiWeeks)} onValueChange={(value) => setWoiWeeks(Number(value) as 4 | 8 | 13)}>
              <SelectTrigger className="w-[130px]" aria-label="WOI calculation window" data-testid="select-explorer-woi-window"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="4">WOI · 4 weeks</SelectItem><SelectItem value="8">WOI · 8 weeks</SelectItem><SelectItem value="13">WOI · 13 weeks</SelectItem></SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => void exportRows()} disabled={!hasRows || exporting || measures.length === 0} data-testid="button-export-explorer">
              <Download className="mr-1.5 h-4 w-4" />{exporting ? "Preparing…" : "Export XLSX"}
            </Button>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4 pb-10 md:p-6 md:pb-12">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-4">
          <Card className="shadow-xs">
            <CardContent className="flex flex-col gap-4 p-4">
              <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
                <div className="min-w-[220px] flex-1">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Dimensions</div>
                  <div className="flex flex-wrap gap-1.5">
                    {DIMENSION_ORDER.map((dimension) => {
                      const active = dimensions.includes(dimension);
                      return <Button key={dimension} variant={active ? "secondary" : "outline"} size="sm" className="h-7 text-xs" aria-pressed={active} onClick={() => toggleDimension(dimension)} data-testid={`dimension-${dimension.toLowerCase()}`}>{dimension}</Button>;
                    })}
                  </div>
                </div>
                <div className="min-w-[320px] flex-[2]">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Measures</div>
                  <div className="flex flex-wrap gap-1.5">
                    {(Object.keys(MEASURE_KEYS) as Measure[]).map((measure) => {
                      const active = measures.includes(measure);
                      return <Button key={measure} variant={active ? "default" : "outline"} size="sm" className="h-7 text-xs" aria-pressed={active} onClick={() => toggleMeasure(measure)} data-testid={`measure-${measure.toLowerCase().replaceAll(" ", "-")}`}>{measure}</Button>;
                    })}
                  </div>
                </div>
                <div className="flex items-center gap-2 self-end text-xs text-muted-foreground">
                  <Badge variant="outline">Window: {apiParams.week_from && apiParams.week_to ? `${apiParams.week_from} – ${apiParams.week_to}` : formatWeekLabel(apiParams.week_iso)}</Badge>
                  <Button variant="ghost" size="sm" className="h-7" onClick={resetDrill} disabled={!path.length} data-testid="button-reset-explorer-drill"><RotateCcw className="mr-1 h-3 w-3" />Reset drill</Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="min-h-[420px] shadow-xs">
            <CardHeader className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/10 px-4 py-3">
              <div className="flex flex-wrap items-center gap-1 text-sm">
                <button type="button" className="font-medium text-primary hover:underline" onClick={resetDrill} data-testid="breadcrumb-explorer-root">All data</button>
                {path.map((entry, index) => (
                  <span key={`${entry.dimension}-${entry.key}`} className="inline-flex items-center gap-1">
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                    <button type="button" className={`hover:underline ${index === path.length - 1 ? "font-semibold" : "text-muted-foreground"}`} onClick={() => setPath((current) => current.slice(0, index + 1))} data-testid={`breadcrumb-${entry.dimension.toLowerCase()}`}>{entry.label}</button>
                  </span>
                ))}
              </div>
              <span className="text-xs text-muted-foreground">{visibleRows.length.toLocaleString()} visible {currentDimension.toLowerCase()} rows</span>
            </CardHeader>
            <CardContent className="p-0">
              {isLoading ? (
                <div className="space-y-3 p-5"><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-4/5" /></div>
              ) : isError ? (
                <div className="flex min-h-[300px] flex-col items-center justify-center gap-3 p-6 text-center">
                  <AlertCircle className="h-8 w-8 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Explorer data could not be loaded.</p>
                  <Button variant="outline" size="sm" onClick={() => void refetch()} data-testid="button-retry-explorer">Try again</Button>
                </div>
              ) : !dimensions.length || !measures.length ? (
                <div className="flex min-h-[300px] items-center justify-center p-6 text-sm text-muted-foreground">Select at least one dimension and one measure.</div>
              ) : !hasRows ? (
                <div className="flex min-h-[300px] flex-col items-center justify-center gap-2 p-6 text-center">
                  <TableProperties className="h-8 w-8 text-muted-foreground/50" />
                  <p className="text-sm font-medium">No rows match this selection.</p>
                  <p className="text-xs text-muted-foreground">Try a different category or adjust the global filters above.</p>
                </div>
              ) : (
                <div className="overflow-auto">
                  <table className="w-full min-w-max text-xs" data-testid="table-explorer">
                    <thead className="sticky top-0 z-10 bg-muted/60">
                      <tr>
                        <th className="min-w-[240px] border-b px-4 py-2.5 text-left font-semibold">{DIMENSION_LABELS[currentDimension]}</th>
                        {measures.map((measure) => <th key={measure} className="min-w-[130px] border-b px-4 py-2.5 text-right font-semibold">{measure}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRows.map((row) => (
                        <tr
                          key={row.key}
                          className={`border-b last:border-0 hover:bg-muted/30 ${row.drill ? "cursor-pointer" : ""}`}
                          onClick={() => drillInto(row)}
                          onKeyDown={(event) => {
                            if (row.drill && (event.key === "Enter" || event.key === " ")) {
                              event.preventDefault();
                              drillInto(row);
                            }
                          }}
                          tabIndex={row.drill ? 0 : undefined}
                          data-testid={`row-explorer-${row.dimension.toLowerCase()}-${row.key}`}
                        >
                          <th scope="row" className="px-4 py-2.5 text-left font-medium">
                            <span className="flex items-center gap-2">
                              <span className={row.drill ? "text-primary" : ""}>{row.label}</span>
                              {row.drill && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                            </span>
                          </th>
                          {measures.map((measure) => (
                            <td key={measure} className="px-4 py-2.5 text-right tabular-nums">
                              <span className={measure === "WOI" && row.woiState === "no_sales" ? "text-muted-foreground" : ""}>
                                {formatValue(row.values[measure], measure, row.woiState)}
                              </span>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {exportError && <p className="border-t px-4 py-3 text-xs text-rose-700" role="alert">{exportError}</p>}
              {data?.pronto_note && <p className="border-t px-4 py-2 text-xs text-muted-foreground">{data.pronto_note}</p>}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
