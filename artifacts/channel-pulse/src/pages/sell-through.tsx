import { useMemo, useRef, useState } from "react";
import {
  exportExplorerView,
  getGetDashboardWeeklySalesQueryKey,
  useGetDashboardWeeklySales,
  useGetResellers,
} from "@workspace/api-client-react";
import { useFilters } from "@/context/filter-context";
import { customerLabel } from "@/lib/customer-display";
import { formatWeekLabel, formatWeekRange, formatWeekSpan } from "@/lib/week-display";
import { sortByOrder, useHeatmapOrder } from "@/hooks/use-heatmap-order";
import { SerialReconciliation, SourceTag } from "@/components/serial-reconciliation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AlertCircle, Check, Download, GripVertical, Info, Pencil, RotateCcw, X } from "lucide-react";

export default function SellThrough() {
  const { apiParams, insightWeek, resellerIds, category } = useFilters();
  const { data: accounts } = useGetResellers();
  const dateSelectionKey = `${apiParams.week_from ?? ""}:${apiParams.week_to ?? apiParams.week_iso ?? insightWeek ?? ""}`;
  const [reconWeek, setReconWeek] = useState<{ base: string; week: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const selectedReconWeek = reconWeek?.base === dateSelectionKey ? reconWeek.week : insightWeek;
  const pickReconWeek = (week: string) => setReconWeek({ base: dateSelectionKey, week });

  const weeklyParams = { ...apiParams, category };
  const {
    data: heatmapData,
    isLoading,
    isError,
    refetch,
  } = useGetDashboardWeeklySales(weeklyParams, {
    query: {
      queryKey: getGetDashboardWeeklySalesQueryKey(weeklyParams),
      refetchOnMount: "always",
      refetchInterval: 30000,
    },
  });

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
  const dragPartRef = useRef<string | null>(null);
  const [dragOverPart, setDragOverPart] = useState<string | null>(null);
  const onPartDragStart = (part: string) => { dragPartRef.current = part; };
  const onPartDragOver = (event: React.DragEvent, part: string) => {
    event.preventDefault();
    if (dragPartRef.current && dragPartRef.current !== part) setDragOverPart(part);
  };
  const onPartDrop = (target: string) => {
    if (dragPartRef.current && dragPartRef.current !== target) reorderPart(dragPartRef.current, target);
    dragPartRef.current = null;
    setDragOverPart(null);
  };
  const onPartDragEnd = () => {
    dragPartRef.current = null;
    setDragOverPart(null);
  };

  const activePartOrder = isEditing ? draftPartOrder : partOrder;
  const displayedParts = useMemo(
    () => heatmapData ? sortByOrder(heatmapData.parts, activePartOrder) : [],
    [heatmapData, activePartOrder],
  );
  const displayedWeeks = useMemo(
    () => [...(heatmapData?.weeks ?? [])].reverse(),
    [heatmapData?.weeks],
  );
  const maxWeeklySales = (heatmapData?.cells ?? []).reduce((max, cell) => Math.max(max, cell.units_sold), 0);
  const accountLabel = resellerIds.length
    ? resellerIds.map(id => customerLabel(accounts?.find(account => account.id === id)?.code ?? String(id))).join(", ")
    : "All accounts";
  const isPeriod = !!apiParams.week_from && !!apiParams.week_to;
  const periodText = isPeriod
    ? formatWeekSpan(apiParams.week_from, apiParams.week_to)
    : formatWeekSpan(heatmapData?.weeks[0], heatmapData?.end_week);
  const hasRows = displayedParts.length > 0 && displayedWeeks.length > 0;

  const exportHeatmap = async () => {
    if (!heatmapData || !hasRows) return;
    setExporting(true);
    setExportError("");
    const cellBySkuWeek = new Map(heatmapData.cells.map(cell => [`${cell.part_no}:${cell.week_iso}`, cell]));
    const columns = ["Stock Code", ...displayedWeeks.map(formatWeekLabel)];
    const rows = displayedParts.map(part => [
      part,
      ...displayedWeeks.map(week => cellBySkuWeek.get(`${part}:${week}`)?.units_sold ?? "—"),
    ]);
    try {
      const workbook = await exportExplorerView({ columns, rows });
      const href = URL.createObjectURL(workbook);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = "channelpulse-sell-through.xlsx";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Excel export could not be completed.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-muted/20">
      <header className="flex-none border-b bg-background px-4 py-4 md:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Sell Through · Phocas view</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Weekly units sold by Account Code and Stock Code
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void exportHeatmap()}
            disabled={!hasRows || exporting}
            data-testid="button-export-sell-through"
          >
            <Download className="mr-1.5 h-4 w-4" />
            {exporting ? "Exporting…" : "Export Excel"}
          </Button>
        </div>
        {exportError && <p className="mt-2 text-right text-xs text-destructive" role="alert">{exportError}</p>}
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
        <div className="space-y-6">
          <Card className="shadow-xs flex min-h-[400px] flex-col" data-testid="sell-through-heatmap">
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 border-b bg-muted/10 px-4 py-3">
              <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-medium">
                Weekly Sell-Through (Units Sold) Heatmap
                <Badge variant="secondary" className="text-xs font-normal">
                  {isPeriod ? periodText : "Last 12 weeks"}
                </Badge>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-4 w-4 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Stock Codes down the left, ISO weeks across the top, newest first.</p>
                    <p>Each cell is units sold that week, summed across the selected accounts.</p>
                    <p>{isPeriod ? "The heatmap shows the selected date range." : "The 12-week window ends at the selected reporting week."}</p>
                    <p>Darker blue means more units sold; 0 means reported zero sales.</p>
                    <p>A dash means no reported data for that stock/week combination.</p>
                    <p>A serials tag means weekly serial reports supplied sell-through where an SOH file had no sold column.</p>
                    <p>Click a cell to open that week in the reconciliation table below.</p>
                  </TooltipContent>
                </Tooltip>
              </CardTitle>

              {!isEditing ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 text-xs text-muted-foreground"
                  onClick={startEditing}
                  disabled={!heatmapData || heatmapData.parts.length === 0}
                  data-testid="button-edit-sell-through-order"
                >
                  <Pencil className="h-3 w-3" />Edit order
                </Button>
              ) : (
                <div className="flex items-center gap-1.5">
                  <span className="mr-1 select-none text-xs text-muted-foreground">Drag SKU rows to reorder</span>
                  <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs text-muted-foreground" onClick={resetToDefaults}>
                    <RotateCcw className="h-3 w-3" />Reset
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={cancelEditing}>
                    <X className="h-3 w-3" />Cancel
                  </Button>
                  <Button size="sm" className="h-7 gap-1 text-xs" onClick={commitOrder}>
                    <Check className="h-3 w-3" />Done
                  </Button>
                </div>
              )}
            </CardHeader>

            <CardContent className="flex-1 overflow-auto p-0">
              <p className="px-4 pt-3 text-xs text-muted-foreground">
                Account Code: {accountLabel} · {periodText}
                {resellerIds.length !== 1 && " · Sales combined across reported accounts"}
              </p>
              <p className="px-4 pt-1 text-xs text-muted-foreground lg:hidden">
                Scroll sideways to see all weeks.
              </p>
              {heatmapData && heatmapData.cells.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 px-4 pt-3 text-xs text-muted-foreground">
                  <span>0 units/wk</span>
                  <span className="h-3 w-28 rounded bg-gradient-to-r from-[#eff1f3] to-[#2672a6]" aria-hidden="true" />
                  <span>{maxWeeklySales.toLocaleString()} units/wk</span>
                  <span className="ml-2">— No reported data</span>
                </div>
              )}
              {isLoading ? (
                <div className="flex h-full items-center justify-center p-8"><Skeleton className="h-full w-full" /></div>
              ) : isError ? (
                <div className="flex flex-col items-center gap-2 p-8 text-muted-foreground">
                  <AlertCircle className="h-8 w-8" />
                  <p>Could not load weekly sell-through.</p>
                  <Button variant="outline" size="sm" onClick={() => void refetch()}>Try again</Button>
                </div>
              ) : !heatmapData || heatmapData.parts.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center p-8 text-muted-foreground">
                  <AlertCircle className="mb-2 h-8 w-8 opacity-50" />
                  <p>No data for this selection.</p>
                  <p className="mt-1 text-xs">Try adjusting the filters above.</p>
                </div>
              ) : (
                <div className="relative inline-block min-w-full p-4">
                  <div
                    className="grid gap-1"
                    style={{ gridTemplateColumns: `${isEditing ? 180 : 152}px repeat(${displayedWeeks.length}, minmax(96px, 1fr))` }}
                  >
                    <div className="sticky left-0 top-0 z-20 border-b bg-card p-2 text-xs font-semibold text-muted-foreground shadow-[1px_0_0_hsl(var(--border))]">
                      Stock Code
                    </div>
                    {displayedWeeks.map(week => (
                      <div
                        key={week}
                        title={formatWeekLabel(week)}
                        aria-label={formatWeekLabel(week)}
                        className="sticky top-0 z-10 border-b bg-card p-2 text-center text-xs font-semibold text-muted-foreground"
                      >
                        <span className="block">{week.slice(5)}</span>
                        <span className="block text-[10px] font-normal">{week.slice(0, 4)}</span>
                        <span className="mt-1 block text-[10px] font-normal leading-tight">{formatWeekRange(week)}</span>
                      </div>
                    ))}
                    {displayedParts.map(part => {
                      const rowCells = heatmapData.cells.filter(cell => cell.part_no === part);
                      const cellMap = new Map(rowCells.map(cell => [cell.week_iso, cell]));
                      const isOver = dragOverPart === part;
                      const isDragging = dragPartRef.current === part;
                      return (
                        <div className="contents group" key={part}>
                          <div
                            draggable={isEditing}
                            onDragStart={() => onPartDragStart(part)}
                            onDragOver={event => onPartDragOver(event, part)}
                            onDrop={() => onPartDrop(part)}
                            onDragEnd={onPartDragEnd}
                            className={`sticky left-0 z-10 flex select-none items-center gap-1 border-b bg-card p-2 text-xs font-medium shadow-[1px_0_0_hsl(var(--border))] transition-all group-hover:bg-muted/50 ${isEditing ? "cursor-grab pr-1 active:cursor-grabbing" : ""} ${isOver ? "rounded-l bg-primary/5 ring-2 ring-inset ring-primary/60" : ""} ${isDragging ? "opacity-40" : ""}`}
                          >
                            {isEditing && <GripVertical className="h-3 w-3 shrink-0 text-muted-foreground/50" />}
                            <span className="truncate" title={part}>{part}</span>
                          </div>
                          {displayedWeeks.map(week => {
                            const cell = cellMap.get(week);
                            if (!cell) {
                              return (
                                <div key={week} title="No reported data" aria-label={`${part}, ${formatWeekLabel(week)}: no reported data`}
                                  className="border-b bg-card p-1 text-center text-muted-foreground transition-colors group-hover:bg-muted/50">
                                  <span className="flex h-8 items-center justify-center text-xs">—</span>
                                </div>
                              );
                            }
                            const intensity = maxWeeklySales > 0 ? Math.max(0, Math.min(1, cell.units_sold / maxWeeklySales)) : 0;
                            const backgroundColor = `rgb(${Math.round(239 - 201 * intensity)}, ${Math.round(241 - 127 * intensity)}, ${Math.round(243 - 77 * intensity)})`;
                            const salesDisplay = cell.units_sold.toLocaleString();
                            return (
                              <div key={week} className="border-b bg-card p-1 transition-colors group-hover:bg-muted/50">
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <div
                                      role="button"
                                      tabIndex={0}
                                      data-testid={`cell-heatmap-${part}-${week}`}
                                      onClick={() => pickReconWeek(week)}
                                      onKeyDown={event => {
                                        if (event.key === "Enter" || event.key === " ") {
                                          event.preventDefault();
                                          pickReconWeek(week);
                                        }
                                      }}
                                      className={`flex h-8 cursor-pointer items-center justify-center gap-1 rounded text-xs font-medium shadow-xs ${selectedReconWeek === week ? "ring-2 ring-violet-500 ring-offset-1" : ""} ${intensity > 0.55 ? "text-white" : "text-slate-900"}`}
                                      style={{ backgroundColor }}
                                      aria-label={`${part}, ${formatWeekLabel(week)}: ${salesDisplay} units sold`}
                                    >
                                      {salesDisplay}
                                      {cell.serials_backed && <SourceTag source="serials" title="Includes serial-report sell-through for accounts whose SOH file has no sold column" />}
                                    </div>
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="text-xs">
                                    <div className="mb-1.5 font-semibold">{part} · {formatWeekLabel(week)}</div>
                                    <div className="space-y-1">
                                      <div>Weekly sell-through: <span className="font-bold">{salesDisplay}</span> units/wk</div>
                                      <div>Account Code: <span className="font-bold">{accountLabel}</span></div>
                                      <div>Based on {cell.reported_accounts} reported account{cell.reported_accounts !== 1 ? "s" : ""}.</div>
                                      {cell.serials_backed && (
                                        <div className="text-violet-700">
                                          Some accounts use serials: sell-through from serial reports (no sold column). Serials reported: {(cell.serials_reported ?? 0).toLocaleString()}.
                                        </div>
                                      )}
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
          </Card>

          <SerialReconciliation
            week={selectedReconWeek}
            windowWeeks={heatmapData?.weeks}
            onWeekChange={pickReconWeek}
            partIds={apiParams.part_ids}
            resellerIds={apiParams.reseller_ids}
            category={category}
            enabled={!!selectedReconWeek}
          />
        </div>
      </div>
    </div>
  );
}
