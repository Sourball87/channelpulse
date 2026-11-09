import { formatWeekLabel } from "@/lib/week-display";
import { customerLabel } from "@/lib/customer-display";
import { useState } from "react";
import { useGetDashboardHeatmap, useGetResellers } from "@workspace/api-client-react";
import { useFilters } from "@/context/filter-context";
import { sortByOrder, useHeatmapOrder } from "@/hooks/use-heatmap-order";
import { useStockMetrics } from "@/hooks/use-stock-metrics";
import { METRIC_INFO, type StockMetric } from "@/lib/metric-selection";
import { MetricPicker } from "@/components/metric-picker";
import { GripVertical } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type Cell = { soh: number; st: number };

// Per-metric heat ramps: SOH blue (existing), ST amber.
function shade(metric: StockMetric, intensity: number): string {
  if (metric === "soh") return `rgb(${Math.round(239 - 201 * intensity)}, ${Math.round(241 - 127 * intensity)}, ${Math.round(243 - 77 * intensity)})`;
  return `rgb(${Math.round(246 - 46 * intensity)}, ${Math.round(242 - 122 * intensity)}, ${Math.round(234 - 214 * intensity)})`;
}

/** Point-in-time view: SOH and ST both come from the single selected (or period-ending) week. */
export function StockOnHandHeatmap({
  category,
  partOrder,
  isEditing = false,
  onReorder,
  dragPart,
  currentDrag,
}: {
  category?: string;
  partOrder?: string[];
  isEditing?: boolean;
  onReorder?: (from: string, to: string) => void;
  dragPart?: (part: string | null) => void;
  currentDrag?: string | null;
}) {
  const { apiParams, insightWeek, resellerIds } = useFilters();
  const stockParams = {
    week_iso: insightWeek,
    category,
    part_ids: apiParams.part_ids,
    reseller_ids: apiParams.reseller_ids,
  };
  const { data, isLoading, isError, refetch } = useGetDashboardHeatmap(stockParams);
  const { data: accounts } = useGetResellers();
  const { resellerOrder } = useHeatmapOrder();
  const { metrics, update } = useStockMetrics();
  const stocks = partOrder ? sortByOrder(data?.parts ?? [], partOrder) : (data?.parts ?? []);
  const [dragOverStock, setDragOverStock] = useState<string | null>(null);
  // Include non-reporting accounts as empty columns, not false zero values.
  const accountCodes = accounts
    ? accounts.filter(account => !resellerIds.length || resellerIds.includes(account.id)).map(account => account.code)
    : data?.resellers ?? [];
  const columns = sortByOrder(accountCodes, resellerOrder);
  const allCells = data?.cells ?? [];
  const cells = new Map(allCells.map(cell => [`${cell.part_no}:${cell.reseller_code}`, cell]));
  const max: Record<StockMetric, number> = {
    soh: allCells.reduce((m, c) => Math.max(m, c.soh), 0),
    st: allCells.reduce((m, c) => Math.max(m, c.st), 0),
  };
  const weekLabel = formatWeekLabel(data?.week_iso ?? insightWeek);

  const totals = (stock: string) => {
    const reported = columns.map(code => cells.get(`${stock}:${code}`)).filter((c): c is NonNullable<typeof c> => !!c);
    if (!reported.length) return null;
    return { soh: reported.reduce((s, c) => s + c.soh, 0), st: reported.reduce((s, c) => s + c.st, 0) };
  };

  const groupEdge = "border-l border-l-border";

  return (
    <Card className="shadow-xs min-w-0" data-testid="soh-heatmap">
      <CardHeader className="px-4 py-3 border-b bg-muted/10 flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-sm font-medium flex flex-wrap items-center gap-2">
          Sell Through & Stock on Hand
          <Badge variant="secondary">{weekLabel}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground mb-3">
          Stock Code by Account Code · ST = units sold in the reporting week; SOH = units on hand at that week's report.
          {" "}For a date range, both ST and SOH use the ending week only (not a period total or average).
          {" "}Totals include the reported accounts in your current selection.
        </p>
        <MetricPicker metrics={metrics} update={update} />
        {isLoading ? <Skeleton className="h-64 w-full" /> : isError ? (
          <div className="py-8 text-center space-y-2">
            <p>Could not load stock on hand and sell through.</p>
            <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-retry-heatmap">Try again</Button>
          </div>
        ) : !stocks.length ? (
          <p className="py-8 text-center text-muted-foreground">No reports for this week and selection.</p>
        ) : !metrics.length ? (
          <div className="py-10 text-center text-sm text-muted-foreground border rounded-md border-dashed" data-testid="status-no-metrics">
            No metric columns selected. Drag ST or SOH into Columns above, or choose a preset.
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground mb-3">
              {metrics.map(metric => (
                <span key={metric} className="inline-flex items-center gap-1.5">
                  <span className="font-semibold text-foreground">{METRIC_INFO[metric].short}</span>
                  <span>0</span>
                  <span className="h-3 w-20 rounded" style={{ background: `linear-gradient(to right, ${shade(metric, 0)}, ${shade(metric, 1)})` }} aria-hidden="true" />
                  <span>{max[metric].toLocaleString()} {METRIC_INFO[metric].unit}</span>
                </span>
              ))}
              <span>0 = reported zero · — No reported data</span>
            </div>
            <div className="max-h-[440px] overflow-auto">
              <table className="w-full text-xs border-separate border-spacing-0" aria-label="Sell through and stock on hand by Stock Code and Account Code">
                <thead>
                  <tr>
                    <th scope="col" rowSpan={2} className="sticky left-0 top-0 z-30 bg-card text-left font-semibold text-muted-foreground p-2 border-b min-w-[152px] align-bottom">
                      Stock Code
                    </th>
                    <th scope="colgroup" colSpan={metrics.length} className={`sticky top-0 z-20 text-center font-semibold p-2 border-b bg-muted/30 ${groupEdge}`}>Total</th>
                    {columns.map(code => (
                      <th key={code} scope="colgroup" colSpan={metrics.length} className={`sticky top-0 z-20 bg-card text-center font-semibold text-muted-foreground p-2 border-b ${groupEdge}`}>{customerLabel(code)}</th>
                    ))}
                  </tr>
                  <tr>
                    {["__total", ...columns].map(code => metrics.map((metric, i) => (
                      <th key={`${code}-${metric}`} scope="col" title={METRIC_INFO[metric].long}
                        className={`sticky top-[34px] z-20 bg-card text-center font-medium text-muted-foreground px-1 py-1 border-b min-w-[56px] ${i === 0 ? groupEdge : ""} ${code === "__total" ? "bg-muted/30" : ""}`}>
                        {METRIC_INFO[metric].short}
                      </th>
                    )))}
                  </tr>
                </thead>
                <tbody>
                  {stocks.map(stock => {
                    const total = totals(stock);
                    return (
                        <tr key={stock} className={`group ${dragOverStock === stock ? "bg-primary/5" : ""}`}>
                        <th
                          scope="row"
                          draggable={isEditing}
                          onDragStart={() => { dragPart?.(stock); }}
                          onDragOver={(event) => { event.preventDefault(); setDragOverStock(stock); }}
                          onDrop={() => { if (currentDrag) onReorder?.(currentDrag, stock); dragPart?.(null); setDragOverStock(null); }}
                          onDragEnd={() => { dragPart?.(null); setDragOverStock(null); }}
                          className={`sticky left-0 z-10 bg-card text-left font-medium p-2 border-b whitespace-nowrap ${isEditing ? "cursor-grab active:cursor-grabbing" : ""}`}
                        >{isEditing && <GripVertical className="mr-1 inline h-3 w-3 text-muted-foreground" />}{stock}</th>
                        {metrics.map((metric, i) => (
                          <td key={`total-${metric}`} className={`p-1 border-b text-center font-semibold tabular-nums bg-muted/30 ${i === 0 ? groupEdge : ""}`}
                            data-testid={`total-${metric}-${stock}`}>
                            {total ? total[metric].toLocaleString() : <span className="text-muted-foreground font-normal">—</span>}
                          </td>
                        ))}
                        {columns.map(code => {
                          const cell = cells.get(`${stock}:${code}`);
                          return metrics.map((metric, i) => {
                            const edge = i === 0 ? groupEdge : "";
                            if (!cell) return (
                              <td key={`${code}-${metric}`} className={`p-1 border-b text-center text-muted-foreground ${edge}`}
                                aria-label={`${stock} at ${customerLabel(code)}: no reported ${METRIC_INFO[metric].short}`}>—</td>
                            );
                            const value = cell[metric];
                            const intensity = max[metric] > 0 ? Math.max(0, Math.min(1, value / max[metric])) : 0;
                            return (
                              <td key={`${code}-${metric}`} className={`p-1 border-b ${edge}`}>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <div
                                      className={`h-8 rounded flex items-center justify-center font-medium tabular-nums ${intensity > 0.55 ? "text-white" : "text-slate-900"}`}
                                      style={{ backgroundColor: shade(metric, intensity) }}
                                      aria-label={`${stock} at ${customerLabel(code)}: ${value.toLocaleString()} ${METRIC_INFO[metric].unit}`}
                                      data-testid={`cell-${metric}-${stock}-${code}`}
                                    >{value.toLocaleString()}</div>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p>{stock} · {customerLabel(code)} · {formatWeekLabel(data?.week_iso)}</p>
                                    <p>Sell through: {cell.st.toLocaleString()} units sold</p>
                                    <p>Stock on hand: {cell.soh.toLocaleString()} units</p>
                                  </TooltipContent>
                                </Tooltip>
                              </td>
                            );
                          });
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
