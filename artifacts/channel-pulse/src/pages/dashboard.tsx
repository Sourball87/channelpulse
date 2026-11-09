import { useMemo, useRef, useState } from "react";
import {
  getGetDashboardKpisQueryKey,
  getGetWoiHeatmapQueryKey,
  useGetDashboardKpis,
  useGetParts,
  useGetResellers,
  useGetWoiHeatmap,
} from "@workspace/api-client-react";
import { useFilters } from "@/context/filter-context";
import { customerLabel } from "@/lib/customer-display";
import { formatWeekLabel, formatWeekSpan, formatWeekText } from "@/lib/week-display";
import { useHeatmapOrder, sortByOrder } from "@/hooks/use-heatmap-order";
import { StockOnHandHeatmap } from "@/components/stock-on-hand-heatmap";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AlertCircle, ArrowDown, ArrowRight, ArrowUp, Check, GripVertical, Pencil, RotateCcw, X } from "lucide-react";

function woiClass(value: number): string {
  if (value < 2) return "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-200";
  if (value < 4) return "bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200";
  if (value <= 12) return "bg-muted text-foreground";
  return "bg-sky-100 text-sky-900 dark:bg-sky-950/60 dark:text-sky-200";
}

export default function Dashboard() {
  const [category, setCategory] = useState("All");
  const [woiWeeks, setWoiWeeks] = useState<4 | 8 | 13>(4);
  const { apiParams, insightWeek, resellerIds } = useFilters();
  const isPeriod = !!apiParams.week_from && !!apiParams.week_to;
  const { data: parts = [], isLoading: partsLoading, isError: partsError } = useGetParts();
  const { data: accounts } = useGetResellers();
  const queryCategory = category === "All" ? undefined : category;
  const kpiParams = { ...apiParams, category: queryCategory };
  const {
    data: kpiData,
    isLoading: isLoadingKpis,
    isError: kpiError,
    refetch: retryKpis,
  } = useGetDashboardKpis(kpiParams, { query: { queryKey: getGetDashboardKpisQueryKey(kpiParams) } });
  const woiParams = {
    ...apiParams,
    weeks: woiWeeks,
    category: queryCategory,
  };
  const {
    data: woiData,
    isLoading: woiLoading,
    isError: woiError,
    refetch: retryWoi,
  } = useGetWoiHeatmap(woiParams, { query: { queryKey: getGetWoiHeatmapQueryKey(woiParams) } });

  const {
    partOrder, draftPartOrder, isEditing, isSaving, startEditing, commitOrder,
    cancelEditing, resetToDefaults, reorderPart,
  } = useHeatmapOrder();
  const dragPartRef = useRef<string | null>(null);
  const [dragPart, setDragPart] = useState<string | null>(null);
  const onDragStart = (part: string) => {
    dragPartRef.current = part;
    setDragPart(part);
  };
  const onDragEnd = () => {
    dragPartRef.current = null;
    setDragPart(null);
  };
  const onDrop = (target: string) => {
    const source = dragPartRef.current;
    if (source && source !== target) reorderPart(source, target);
    onDragEnd();
  };

  const categories = useMemo(
    () => ["All", ...Array.from(new Set(parts.filter((part) => part.active !== false).map((part) => part.category).filter((value) => Boolean(value) && value !== "HDD & Memory"))).sort((a, b) => a.localeCompare(b))],
    [parts],
  );
  const orderedWoiRows = useMemo(() => {
    if (!woiData) return [];
    const rows = [...woiData.rows];
    const order = isEditing ? draftPartOrder : partOrder;
    const positions = new Map(order.map((part, index) => [part.toLowerCase(), index]));
    return rows.sort((a, b) => (positions.get(a.part_no.toLowerCase()) ?? Infinity) - (positions.get(b.part_no.toLowerCase()) ?? Infinity));
  }, [woiData, isEditing, draftPartOrder, partOrder]);
  const kpiCards = kpiData?.kpis ?? [];
  const reportedCount = kpiData?.reseller_statuses.filter((reseller) => reseller.reported).length ?? 0;
  const totalResellers = kpiData?.reseller_statuses.length ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-muted/20">
      <header className="flex-none border-b bg-background px-4 py-4 md:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {kpiData?.is_period
                ? `Period: ${formatWeekText(kpiData.period_label ?? "")}`
                : `Inventory position and sell-through · ${formatWeekLabel(kpiData?.week_iso ?? insightWeek)}`}
            </p>
          </div>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="w-[170px]" aria-label="Filter dashboard by category" data-testid="select-dashboard-category">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>{categories.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-12 pt-5 md:px-6 md:pb-14">
        <div className="space-y-5">
          <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Dashboard metrics">
            {isLoadingKpis ? Array.from({ length: 4 }).map((_, index) => (
              <Card key={index}><CardContent className="space-y-3 p-4"><Skeleton className="h-4 w-28" /><Skeleton className="h-8 w-32" /><Skeleton className="h-3 w-24" /></CardContent></Card>
            )) : kpiError ? (
              <Card className="sm:col-span-2 xl:col-span-4"><CardContent className="flex items-center justify-between gap-3 p-4 text-sm">
                <span className="flex items-center gap-2 text-muted-foreground"><AlertCircle className="h-4 w-4" />Dashboard metrics are unavailable.</span>
                <Button variant="outline" size="sm" onClick={() => void retryKpis()} data-testid="button-retry-dashboard-kpis">Try again</Button>
              </CardContent></Card>
            ) : kpiCards.map((kpi) => (
              <Card key={kpi.label} className="shadow-xs">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">{kpi.label}</CardTitle>
                  {kpi.delta_direction === "up" ? <ArrowUp className="h-4 w-4 text-emerald-600" /> : kpi.delta_direction === "down" ? <ArrowDown className="h-4 w-4 text-rose-600" /> : <ArrowRight className="h-4 w-4 text-muted-foreground" />}
                </CardHeader>
                <CardContent className="p-4 pt-0">
                  <div className="text-2xl font-semibold tabular-nums">{kpi.formatted || kpi.value?.toLocaleString() || "—"}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    <span className={kpi.delta_direction === "up" ? "font-medium text-emerald-700" : kpi.delta_direction === "down" ? "font-medium text-rose-700" : ""}>
                      {kpi.delta_pct != null ? `${kpi.delta_pct > 0 ? "+" : ""}${kpi.delta_pct.toFixed(1)}%` : "—"}
                    </span>{" "}
                    {formatWeekText(kpiData?.delta_label ?? "vs last week")}
                  </div>
                </CardContent>
              </Card>
            ))}
          </section>

          <Card className="shadow-xs">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 border-b bg-muted/10 px-4 py-3">
              <CardTitle className="text-sm font-medium">Reporting status · {formatWeekLabel(kpiData?.week_iso)}</CardTitle>
              <Badge variant={reportedCount === totalResellers && totalResellers > 0 ? "default" : "secondary"}>{reportedCount} of {totalResellers} reported</Badge>
            </CardHeader>
            <CardContent className="p-0">
              {kpiError ? <p className="px-4 py-5 text-sm text-muted-foreground">Reporting status could not be loaded.</p> : (
                <div className="flex gap-1 overflow-x-auto p-2">
                  {kpiData?.reseller_statuses.map((reseller) => (
                    <div key={reseller.reseller_id} className={`min-w-[82px] flex-1 rounded border p-2 text-center text-xs font-medium ${reseller.reported ? "border-emerald-600/20 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300" : "border-border bg-muted text-muted-foreground"}`}>
                      <div className="truncate">{customerLabel(reseller.code)}</div>
                      <div className="mt-1 text-[10px] font-normal opacity-70">{reseller.reported ? "Reported" : "Missing"}</div>
                    </div>
                  ))}
                  {!kpiData?.reseller_statuses.length && <span className="px-2 py-3 text-xs text-muted-foreground">No reporting status available for this selection.</span>}
                </div>
              )}
            </CardContent>
          </Card>

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-card px-3 py-2">
            <div className="text-sm font-medium">SKU row order <span className="ml-1 text-xs font-normal text-muted-foreground">Shared by both dashboard tables</span></div>
            {!isEditing ? (
              <Button variant="outline" size="sm" onClick={startEditing} disabled={partsLoading || parts.length === 0} data-testid="button-edit-sku-order">
                <Pencil className="mr-1.5 h-3.5 w-3.5" />Edit order
              </Button>
            ) : (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-2 text-xs text-muted-foreground">Drag a SKU row to move it</span>
                <Button variant="ghost" size="sm" onClick={resetToDefaults} disabled={isSaving} data-testid="button-reset-sku-order"><RotateCcw className="mr-1 h-3.5 w-3.5" />Reset order</Button>
                <Button variant="ghost" size="sm" onClick={cancelEditing} disabled={isSaving} data-testid="button-cancel-sku-order"><X className="mr-1 h-3.5 w-3.5" />Cancel</Button>
                <Button size="sm" onClick={commitOrder} disabled={isSaving} data-testid="button-save-sku-order"><Check className="mr-1 h-3.5 w-3.5" />{isSaving ? "Saving…" : "Save"}</Button>
              </div>
            )}
          </div>
          {partsError && <p className="text-xs text-rose-700">SKU order could not be loaded. You can still review available inventory.</p>}
          <StockOnHandHeatmap
            category={queryCategory}
            partOrder={isEditing ? draftPartOrder : partOrder}
            isEditing={isEditing}
            onReorder={onDrop}
            dragPart={onDragStart}
            currentDrag={dragPart}
          />

          <Card className="shadow-xs" data-testid="woi-heatmap">
            <CardHeader className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/10 px-4 py-3">
              <div>
                <CardTitle className="text-sm font-medium">Weeks of inventory</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  {isPeriod
                    ? `SOH at each customer's latest report · sales ${formatWeekSpan(apiParams.week_from, apiParams.week_to)} (${woiData?.window_weeks ?? 0} weeks). The selected period sets this window.`
                    : `SOH as at ${formatWeekLabel(woiData?.week_iso ?? insightWeek)} · sales ${woiData?.weeks.length ? formatWeekSpan(woiData.weeks[0], woiData.weeks.at(-1)) : `${woiWeeks} weeks`} (${woiData?.window_weeks ?? woiWeeks} weeks)`}
                </p>
              </div>
              <Select value={String(woiWeeks)} onValueChange={(value) => setWoiWeeks(Number(value) as 4 | 8 | 13)} disabled={isPeriod}>
                <SelectTrigger className="h-8 w-[120px]" aria-label="WOI coverage window" data-testid="select-woi-window"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="4">4 weeks</SelectItem><SelectItem value="8">8 weeks</SelectItem><SelectItem value="13">13 weeks</SelectItem>
                </SelectContent>
              </Select>
            </CardHeader>
            <CardContent className="p-0">
              {woiLoading ? <div className="space-y-2 p-4"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-4/5" /></div> : woiError ? (
                <div className="flex items-center justify-between gap-3 p-6 text-sm">
                  <span className="flex items-center gap-2 text-muted-foreground"><AlertCircle className="h-4 w-4" />Weeks of inventory could not be loaded.</span>
                  <Button variant="outline" size="sm" onClick={() => void retryWoi()} data-testid="button-retry-woi">Try again</Button>
                </div>
              ) : !orderedWoiRows.length ? (
                <div className="px-4 py-10 text-center text-sm text-muted-foreground">No inventory coverage for this selection.</div>
              ) : (
                <div className="max-h-[460px] overflow-auto">
                  <table className="w-full min-w-max border-separate border-spacing-0 text-xs" aria-label="Weeks of inventory by SKU and customer">
                    <thead className="sticky top-0 z-20 bg-card">
                      <tr>
                        <th className="sticky left-0 z-30 min-w-[180px] border-b bg-card p-2 text-left font-semibold text-muted-foreground">SKU</th>
                        {woiData?.customers.filter((customer) => !resellerIds.length || resellerIds.includes(customer.id)).map((customer) => (
                          <th key={customer.id} className="min-w-[92px] border-b p-2 text-center font-semibold text-muted-foreground">{customerLabel(customer.code)}</th>
                        ))}
                        <th className="min-w-[110px] border-b bg-muted/30 p-2 text-center font-semibold">Channel total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orderedWoiRows.map((row) => {
                        const cells = row.cells.filter((cell) => !resellerIds.length || cell.reseller_id == null || resellerIds.includes(cell.reseller_id));
                        const getCell = (id: number) => cells.find((cell) => cell.reseller_id === id);
                        const cellDisplay = (cell: typeof row.channel_total | undefined, label: string) => {
                          if (!cell) return <span className="text-muted-foreground">—</span>;
                          const display = cell.state === "no_sales"
                            ? <span className="font-medium text-muted-foreground">No sales</span>
                            : cell.state === "no_soh"
                              ? <span className="text-muted-foreground">No SOH</span>
                              : cell.state === "no_sales_data"
                                ? <span className="text-muted-foreground">No sales data</span>
                                : cell.woi == null
                                  ? <span className="text-muted-foreground">—</span>
                                  : <span className={`inline-flex min-w-[54px] justify-center rounded px-2 py-1 font-semibold tabular-nums ${woiClass(cell.woi)}`}>{cell.woi.toFixed(1)}</span>;
                          return (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                  <span className="inline-flex min-w-[54px] cursor-default flex-col items-center justify-center rounded px-2 py-1 text-center" data-testid={`cell-woi-${row.part_id}-${cell.reseller_id ?? "total"}`}>
                                    {display}
                                    {isPeriod && cell.as_at_week && (
                                      <span className="mt-0.5 text-[9px] font-normal text-muted-foreground">SOH as at {formatWeekLabel(cell.as_at_week)}</span>
                                    )}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent className="text-xs">
                                <p className="mb-1 font-semibold">{row.part_no} · {label}</p>
                                <p>SOH: {cell.soh == null ? "Not reported" : `${cell.soh.toLocaleString()}${cell.as_at_week ? ` · as at ${formatWeekLabel(cell.as_at_week)}` : ""}`}</p>
                                <p>{isPeriod ? "Total sold in selected period" : "Total sold in coverage window"}: {cell.sales_total == null ? "Not available" : cell.sales_total.toLocaleString()}</p>
                                <p>Average weekly sales: {cell.avg_weekly_sales == null ? "Not available" : cell.avg_weekly_sales.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
                                <p>WOI: {cell.state === "value" && cell.woi != null ? `${cell.woi.toFixed(1)} weeks` : cell.state === "no_sales" ? "No sales" : "Not available"}</p>
                                <p>Data coverage: {label === "Channel total" ? "Varies by customer" : `${cell.weeks_observed} of ${cell.window_weeks} weeks`}</p>
                              </TooltipContent>
                            </Tooltip>
                          );
                        };
                        return (
                          <tr key={row.part_id} className="group">
                            <th
                              scope="row"
                              draggable={isEditing}
                              onDragStart={() => onDragStart(row.part_no)}
                              onDragOver={(event) => event.preventDefault()}
                              onDrop={() => onDrop(row.part_no)}
                              onDragEnd={onDragEnd}
                              className={`sticky left-0 z-10 border-b bg-card p-2 text-left font-medium ${isEditing ? "cursor-grab active:cursor-grabbing" : ""}`}
                            >{isEditing && <GripVertical className="mr-1 inline h-3 w-3 text-muted-foreground" />}{row.part_no}</th>
                            {woiData?.customers.filter((customer) => !resellerIds.length || resellerIds.includes(customer.id)).map((customer) => (
                              <td key={customer.id} className="border-b p-1 text-center">{cellDisplay(getCell(customer.id), customerLabel(customer.code))}</td>
                            ))}
                            <td className="border-b bg-muted/30 p-1 text-center">{cellDisplay(row.channel_total, "Channel total")}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
