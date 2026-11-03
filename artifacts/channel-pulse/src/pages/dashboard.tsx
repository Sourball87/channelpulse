import { customerLabel } from "@/lib/customer-display";
import { useState, useRef } from "react";
import { Link } from "wouter";
import {
  useGetDashboardKpis,
  useGetDashboardWeeklySales,
  useGetResellers,
  getGetDashboardKpisQueryKey,
  getGetDashboardWeeklySalesQueryKey,
} from "@workspace/api-client-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  AlertCircle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  GripVertical,
  Info,
  Pencil,
  RotateCcw,
  Check,
  X,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useFilters } from "@/context/filter-context";
import { useHeatmapOrder, sortByOrder } from "@/hooks/use-heatmap-order";
import { StockOnHandHeatmap } from "@/components/stock-on-hand-heatmap";

const CATEGORIES = ["All", "SSD", "Monitor", "Mobility", "HDD & Memory"];

export default function Dashboard() {
  const [category, setCategory] = useState<string>("All");
  const { apiParams, insightWeek, resellerIds, focusView } = useFilters();
  const { data: accounts } = useGetResellers();

  const queryCategory = category === "All" ? undefined : category;

  const kpiParams = {
    ...apiParams,
    category: queryCategory,
  };
  const { data: kpiData, isLoading: isLoadingKpis } = useGetDashboardKpis(kpiParams, {
    query: { enabled: !focusView, queryKey: getGetDashboardKpisQueryKey(kpiParams) },
  });

  const weeklyParams = {
    week_iso: insightWeek,
    part_ids: apiParams.part_ids,
    reseller_ids: apiParams.reseller_ids,
    category: queryCategory,
  };
  const { data: heatmapData, isLoading: isLoadingHeatmap, isError: heatmapError, refetch: refetchHeatmap } = useGetDashboardWeeklySales(
    weeklyParams,
    { query: { enabled: focusView, queryKey: getGetDashboardWeeklySalesQueryKey(weeklyParams) } },
  );

  const {
    partOrder,
    draftPartOrder,
    isEditing,
    startEditing,
    commitOrder,
    cancelEditing,
    resetToDefaults,
    reorderPart,
  } = useHeatmapOrder();

  // ── Drag state ──────────────────────────────────────────────────────────────
  const dragPartRef = useRef<string | null>(null);
  const [dragOverPart, setDragOverPart] = useState<string | null>(null);

  // Part row drag handlers
  const onPartDragStart = (part: string) => { dragPartRef.current = part; };
  const onPartDragOver = (e: React.DragEvent, part: string) => {
    e.preventDefault();
    if (dragPartRef.current && dragPartRef.current !== part) setDragOverPart(part);
  };
  const onPartDrop = (targetPart: string) => {
    if (dragPartRef.current && dragPartRef.current !== targetPart) {
      reorderPart(dragPartRef.current, targetPart);
    }
    dragPartRef.current = null;
    setDragOverPart(null);
  };
  const onPartDragEnd = () => {
    dragPartRef.current = null;
    setDragOverPart(null);
  };


  // ── Sorted display data ─────────────────────────────────────────────────────
  const activePartOrder = isEditing ? draftPartOrder : partOrder;

  const displayedParts = heatmapData
    ? sortByOrder(heatmapData.parts, activePartOrder)
    : [];
  // Newest week first; copy so the shared query-cache data stays unchanged.
  const displayedWeeks = [...(heatmapData?.weeks ?? [])].reverse();
  const maxWeeklySales = (heatmapData?.cells ?? []).reduce((max, cell) => Math.max(max, cell.units_sold), 0);
  const accountLabel = resellerIds.length
    ? resellerIds.map(id => customerLabel(accounts?.find(account => account.id === id)?.code ?? String(id))).join(", ")
    : "All accounts";

  const reportedCount = kpiData?.reseller_statuses.filter((r) => r.reported).length || 0;
  const totalResellers = kpiData?.reseller_statuses.length || 9;
  const deltaLabel = kpiData?.delta_label ?? "vs last week";

  return (
    <div className="flex flex-col h-full bg-muted/20">
      <header className="flex-none bg-background border-b px-6 py-4 flex flex-wrap gap-3 items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{focusView ? "Sell Through" : "SOH"}</h1>
          <p className="text-sm text-muted-foreground">
            {focusView ? "Phocas view · Weekly units sold by Account Code and Stock Code" : kpiData?.is_period
              ? `Period: ${kpiData.period_label}`
              : `Stock on Hand — ${kpiData?.week_iso ?? "Latest week"}`}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <Tabs value={category} onValueChange={setCategory} className="w-auto">
            <TabsList>
              {CATEGORIES.map((c) => (
                <TabsTrigger key={c} value={c} className="text-xs px-3">
                  {c}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-6 space-y-6">
        {!focusView && <>
        <div className="grid grid-cols-4 gap-4">
          {isLoadingKpis
            ? Array.from({ length: 4 }).map((_, i) => (
                <Card key={i} className="shadow-xs">
                  <CardHeader className="p-4 pb-2">
                    <Skeleton className="h-4 w-24" />
                  </CardHeader>
                  <CardContent className="p-4 pt-0">
                    <Skeleton className="h-8 w-32" />
                  </CardContent>
                </Card>
              ))
            : kpiData?.kpis.map((kpi) => (
                <Card key={kpi.label} className="shadow-xs">
                  <CardHeader className="p-4 pb-2 flex flex-row items-center justify-between space-y-0">
                    <CardTitle className="text-sm font-medium text-muted-foreground">
                      {kpi.label}
                    </CardTitle>
                    {kpi.delta_direction === "up" && (
                      <ArrowUp className="h-4 w-4 text-emerald-500" />
                    )}
                    {kpi.delta_direction === "down" && (
                      <ArrowDown className="h-4 w-4 text-rose-500" />
                    )}
                    {kpi.delta_direction === "flat" && (
                      <ArrowRight className="h-4 w-4 text-muted-foreground" />
                    )}
                  </CardHeader>
                  <CardContent className="p-4 pt-0">
                    <div className="text-2xl font-bold">
                      {kpi.formatted || kpi.value?.toLocaleString()}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                      <span
                        className={
                          kpi.delta_direction === "up"
                            ? "text-emerald-500 font-medium"
                            : kpi.delta_direction === "down"
                            ? "text-rose-500 font-medium"
                            : ""
                        }
                      >
                        {kpi.delta_pct != null
                          ? `${kpi.delta_pct > 0 ? "+" : ""}${kpi.delta_pct.toFixed(1)}%`
                          : "0%"}
                      </span>
                      <span> {deltaLabel}</span>
                    </div>
                  </CardContent>
                </Card>
              ))}
        </div>

        <Card className="shadow-xs">
          <CardHeader className="px-4 py-3 border-b bg-muted/10 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm font-medium">
              Reporting Status: {kpiData?.week_iso || "Week"}
            </CardTitle>
            <Badge
              variant={reportedCount === totalResellers ? "default" : "secondary"}
            >
              {reportedCount} of {totalResellers} Reported
            </Badge>
          </CardHeader>
          <CardContent className="p-0">
            <div className="flex gap-1 p-2 overflow-x-auto">
              {kpiData?.reseller_statuses.map((reseller) => (
                <div
                  key={reseller.reseller_id}
                  className={`flex-1 min-w-[80px] text-center p-2 rounded-md border text-xs font-medium ${
                    reseller.reported
                      ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-700 dark:text-emerald-400"
                      : "bg-muted border-border text-muted-foreground"
                  }`}
                >
                  <div className="truncate">{customerLabel(reseller.code)}</div>
                  <div className="text-[10px] mt-1 opacity-70 font-normal">
                    {reseller.reported ? "Reported" : "Missing"}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        </>}
        {focusView ? <Card className="shadow-xs flex-1 flex flex-col min-h-[400px]" data-testid="sell-through-heatmap">
          <CardHeader className="px-4 py-3 border-b bg-muted/10 flex flex-row flex-wrap gap-2 items-center justify-between space-y-0">
            <CardTitle className="text-sm font-medium flex flex-wrap items-center gap-2">
              Weekly Sell-Through (Units Sold) Heatmap
              <Badge variant="secondary" className="text-xs font-normal">Last 12 weeks</Badge>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-4 w-4 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent>
                  <p>Stock Codes down the left, 12 consecutive ISO weeks across the top, newest first.</p>
                  <p>Each cell is units sold that week, summed across the selected accounts.</p>
                  <p>The window ends at the selected reporting week or date-range end.</p>
                  <p>Darker blue means more units sold; 0 means reported zero sales.</p>
                  <p>A dash means no reported data for that stock/week combination.</p>
                </TooltipContent>
              </Tooltip>
            </CardTitle>

            {/* Edit order controls */}
            {!isEditing ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-xs text-muted-foreground"
                onClick={startEditing}
                disabled={!heatmapData || heatmapData.parts.length === 0}
              >
                <Pencil className="h-3 w-3" />
                Edit order
              </Button>
            ) : (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground mr-1 select-none">
                  Drag SKU rows to reorder
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 text-xs text-muted-foreground"
                  onClick={resetToDefaults}
                >
                  <RotateCcw className="h-3 w-3" />
                  Reset
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  onClick={cancelEditing}
                >
                  <X className="h-3 w-3" />
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  onClick={commitOrder}
                >
                  <Check className="h-3 w-3" />
                  Done
                </Button>
              </div>
            )}
          </CardHeader>

          <CardContent className="p-0 overflow-auto flex-1">
            <p className="px-4 pt-3 text-xs text-muted-foreground">
              Account Code: {accountLabel} · {heatmapData?.weeks[0] ?? "…"} – {heatmapData?.end_week ?? "…"}
              {resellerIds.length !== 1 && " · Sales combined across reported accounts"}
            </p>
            <p className="px-4 pt-1 text-xs text-muted-foreground lg:hidden">
              Scroll sideways to see all 12 weeks.
            </p>
            {heatmapData && heatmapData.cells.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 px-4 pt-3 text-xs text-muted-foreground">
                <span>0 units/wk</span>
                <span className="h-3 w-28 rounded bg-gradient-to-r from-[#eff1f3] to-[#2672a6]" aria-hidden="true" />
                <span>{maxWeeklySales.toLocaleString()} units/wk</span>
                <span className="ml-2">— No reported data</span>
              </div>
            )}
            {isLoadingHeatmap ? (
              <div className="p-8 flex items-center justify-center h-full">
                <Skeleton className="h-full w-full" />
              </div>
            ) : heatmapError ? (
              <div className="p-8 flex flex-col items-center gap-2 text-muted-foreground">
                <AlertCircle className="h-8 w-8" />
                <p>Could not load weekly sell-through.</p>
                <Button variant="outline" size="sm" onClick={() => refetchHeatmap()}>Try again</Button>
              </div>
            ) : !heatmapData || heatmapData.parts.length === 0 ? (
              <div className="p-8 flex flex-col items-center justify-center h-full text-muted-foreground">
                <AlertCircle className="h-8 w-8 mb-2 opacity-50" />
                <p>No data for this selection.</p>
                <p className="text-xs mt-1">Try adjusting the filters above.</p>
              </div>
            ) : (
              <div className="inline-block min-w-full relative p-4">
                <div
                  className="grid gap-1"
                  style={{
                    gridTemplateColumns: `${isEditing ? 180 : 152}px repeat(${displayedWeeks.length}, minmax(60px, 1fr))`,
                  }}
                >
                  {/* Header row — top-left corner */}
                  <div className="sticky top-0 left-0 z-20 bg-card p-2 text-xs font-semibold text-muted-foreground border-b shadow-[1px_0_0_hsl(var(--border))]">
                    Stock Code
                  </div>

                  {/* ISO weeks always stay newest-first. */}
                  {displayedWeeks.map((week) => {
                    return (
                      <div
                        key={week}
                        title={week}
                        aria-label={week}
                        className="sticky top-0 z-10 bg-card p-2 text-xs font-semibold text-center border-b text-muted-foreground"
                      >
                        <span className="block">{week.slice(5)}</span>
                        <span className="block text-[10px] font-normal">{week.slice(0, 4)}</span>
                      </div>
                    );
                  })}

                  {/* Data rows */}
                  {displayedParts.map((part) => {
                    const rowCells = heatmapData.cells.filter((c) => c.part_no === part);
                    const cellMap = new Map(rowCells.map((c) => [c.week_iso, c]));
                    const isOver = dragOverPart === part;
                    const isDragging = dragPartRef.current === part;

                    return (
                      <div className="contents group" key={part}>
                        {/* Row label / drag handle */}
                        <div
                          draggable={isEditing}
                          onDragStart={() => onPartDragStart(part)}
                          onDragOver={(e) => onPartDragOver(e, part)}
                          onDrop={() => onPartDrop(part)}
                          onDragEnd={onPartDragEnd}
                          className={`sticky left-0 z-10 bg-card p-2 text-xs font-medium border-b flex items-center gap-1 group-hover:bg-muted/50 shadow-[1px_0_0_hsl(var(--border))] transition-all select-none
                            ${isEditing ? "cursor-grab active:cursor-grabbing pr-1" : ""}
                            ${isOver ? "ring-2 ring-inset ring-primary/60 bg-primary/5 rounded-l" : ""}
                            ${isDragging ? "opacity-40" : ""}
                          `}
                        >
                          {isEditing && (
                            <GripVertical className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                          )}
                          <span className="truncate" title={part}>
                            {part}
                          </span>
                        </div>

                        {/* Data cells */}
                        {displayedWeeks.map((week) => {
                          const cell = cellMap.get(week);

                          if (!cell) {
                            return (
                              <div
                                key={week}
                                title="No reported data"
                                aria-label={`${part}, ${week}: no reported data`}
                                className="p-1 border-b bg-card group-hover:bg-muted/50 transition-colors text-center text-muted-foreground"
                              >
                                <span className="h-8 flex items-center justify-center text-xs">—</span>
                              </div>
                            );
                          }

                          const intensity = maxWeeklySales > 0 ? Math.max(0, Math.min(1, cell.units_sold / maxWeeklySales)) : 0;
                          const backgroundColor = `rgb(${Math.round(239 - 201 * intensity)}, ${Math.round(241 - 127 * intensity)}, ${Math.round(243 - 77 * intensity)})`;
                          const salesDisplay = cell.units_sold.toLocaleString();

                          return (
                            <div
                              key={week}
                              className="p-1 border-b bg-card group-hover:bg-muted/50 transition-colors"
                            >
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div
                                    className={`h-8 rounded flex items-center justify-center text-xs font-medium cursor-default shadow-xs ${intensity > 0.55 ? "text-white" : "text-slate-900"}`}
                                    style={{ backgroundColor }}
                                    aria-label={`${part}, ${week}: ${salesDisplay} units sold`}
                                  >
                                    {salesDisplay}
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="text-xs">
                                  <div className="font-semibold mb-1.5">
                                    {part} · {week}
                                  </div>
                                  <div className="space-y-1">
                                    <div>
                                      Weekly sell-through:{" "}
                                      <span className="font-bold">
                                        {salesDisplay}
                                      </span>{" "}
                                      units/wk
                                    </div>
                                    <div>
                                      Account Code:{" "}
                                      <span className="font-bold">
                                        {accountLabel}
                                      </span>{" "}
                                    </div>
                                    <div>
                                      Based on {cell.reported_accounts} reported account{cell.reported_accounts !== 1 ? "s" : ""}.
                                    </div>
                                  </div>
                                </TooltipContent>
                              </Tooltip>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </CardContent>
        </Card> : <StockOnHandHeatmap category={queryCategory} />}
      </div>
    </div>
  );
}
