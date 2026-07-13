import { useState, useRef } from "react";
import { Link } from "wouter";
import {
  useGetDashboardKpis,
  useGetDashboardHeatmap,
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

const CATEGORIES = ["All", "SSD", "Monitor", "Mobility", "HDD & Memory"];

export default function Dashboard() {
  const [category, setCategory] = useState<string>("All");
  const { apiParams } = useFilters();

  const queryCategory = category === "All" ? undefined : category;

  const { data: kpiData, isLoading: isLoadingKpis } = useGetDashboardKpis({
    ...apiParams,
    category: queryCategory,
  });

  const { data: heatmapData, isLoading: isLoadingHeatmap } = useGetDashboardHeatmap({
    ...apiParams,
    category: queryCategory,
  });

  const {
    partOrder,
    resellerOrder,
    draftPartOrder,
    draftResellerOrder,
    isEditing,
    startEditing,
    commitOrder,
    cancelEditing,
    resetToDefaults,
    reorderPart,
    reorderReseller,
  } = useHeatmapOrder();

  // ── Drag state ──────────────────────────────────────────────────────────────
  const dragPartRef = useRef<string | null>(null);
  const [dragOverPart, setDragOverPart] = useState<string | null>(null);
  const dragResellerRef = useRef<string | null>(null);
  const [dragOverReseller, setDragOverReseller] = useState<string | null>(null);

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

  // Reseller column drag handlers
  const onResellerDragStart = (res: string) => { dragResellerRef.current = res; };
  const onResellerDragOver = (e: React.DragEvent, res: string) => {
    e.preventDefault();
    if (dragResellerRef.current && dragResellerRef.current !== res) setDragOverReseller(res);
  };
  const onResellerDrop = (targetRes: string) => {
    if (dragResellerRef.current && dragResellerRef.current !== targetRes) {
      reorderReseller(dragResellerRef.current, targetRes);
    }
    dragResellerRef.current = null;
    setDragOverReseller(null);
  };
  const onResellerDragEnd = () => {
    dragResellerRef.current = null;
    setDragOverReseller(null);
  };

  // ── Sorted display data ─────────────────────────────────────────────────────
  const activePartOrder = isEditing ? draftPartOrder : partOrder;
  const activeResellerOrder = isEditing ? draftResellerOrder : resellerOrder;

  const displayedParts = heatmapData
    ? sortByOrder(heatmapData.parts, activePartOrder)
    : [];
  const displayedResellers = heatmapData
    ? sortByOrder(heatmapData.resellers, activeResellerOrder)
    : [];

  const reportedCount = kpiData?.reseller_statuses.filter((r) => r.reported).length || 0;
  const totalResellers = kpiData?.reseller_statuses.length || 9;
  const deltaLabel = kpiData?.delta_label ?? "vs last week";

  return (
    <div className="flex flex-col h-full bg-muted/20">
      <header className="flex-none bg-background border-b px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            {kpiData?.is_period
              ? `Period: ${kpiData.period_label}`
              : `SOH & Sell-Through — ${kpiData?.week_iso ?? "Latest week"}`}
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
                  <div className="truncate">{reseller.code}</div>
                  <div className="text-[10px] mt-1 opacity-70 font-normal">
                    {reseller.reported ? "Reported" : "Missing"}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-xs flex-1 flex flex-col min-h-[400px]">
          <CardHeader className="px-4 py-3 border-b bg-muted/10 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              Weeks of Inventory (WOI) Heatmap
              {kpiData?.is_period && (
                <Badge variant="secondary" className="text-xs font-normal">
                  SOH: latest week · ST: avg over period
                </Badge>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-4 w-4 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent>
                  <p>Green: ≤8 weeks</p>
                  <p>Amber: 9-15 weeks</p>
                  <p>Red: &gt;15 weeks or no sales</p>
                  <p>Grey: Out of stock</p>
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
                  Drag rows &amp; columns to reorder
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
            {isLoadingHeatmap ? (
              <div className="p-8 flex items-center justify-center h-full">
                <Skeleton className="h-full w-full" />
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
                    gridTemplateColumns: `minmax(${isEditing ? 200 : 180}px, max-content) repeat(${displayedResellers.length}, minmax(60px, 1fr))`,
                  }}
                >
                  {/* Header row — top-left corner */}
                  <div className="sticky top-0 left-0 z-20 bg-card p-2 text-xs font-semibold text-muted-foreground border-b shadow-[1px_0_0_hsl(var(--border))]">
                    Part / Reseller
                  </div>

                  {/* Reseller column headers */}
                  {displayedResellers.map((res) => {
                    const isOver = dragOverReseller === res;
                    const isDragging = dragResellerRef.current === res;
                    return (
                      <div
                        key={res}
                        draggable={isEditing}
                        onDragStart={() => onResellerDragStart(res)}
                        onDragOver={(e) => onResellerDragOver(e, res)}
                        onDrop={() => onResellerDrop(res)}
                        onDragEnd={onResellerDragEnd}
                        className={`sticky top-0 z-10 bg-card p-2 text-xs font-semibold text-center border-b text-muted-foreground transition-all select-none
                          ${isEditing ? "cursor-grab active:cursor-grabbing" : ""}
                          ${isOver ? "ring-2 ring-inset ring-primary/60 bg-primary/5 rounded" : ""}
                          ${isDragging ? "opacity-40" : ""}
                        `}
                      >
                        {isEditing && (
                          <GripVertical className="h-3 w-3 mx-auto mb-0.5 text-muted-foreground/50 rotate-90" />
                        )}
                        {res}
                      </div>
                    );
                  })}

                  {/* Data rows */}
                  {displayedParts.map((part) => {
                    const rowCells = heatmapData.cells.filter((c) => c.part_no === part);
                    const cellMap = new Map(rowCells.map((c) => [c.reseller_code, c]));
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
                          <span className="truncate" title={rowCells[0]?.display_name || part}>
                            {part}
                          </span>
                        </div>

                        {/* Data cells */}
                        {displayedResellers.map((res) => {
                          const cell = cellMap.get(res);
                          const colOver = dragOverReseller === res;
                          const colDragging = dragResellerRef.current === res;

                          if (!cell || cell.color === "empty") {
                            return (
                              <div
                                key={res}
                                className={`p-1 border-b bg-card group-hover:bg-muted/50 transition-colors
                                  ${colOver ? "bg-primary/5" : ""}
                                  ${colDragging ? "opacity-40" : ""}
                                `}
                              />
                            );
                          }

                          let bgColor = "bg-muted text-muted-foreground";
                          if (cell.color === "green")
                            bgColor = "bg-[hsl(var(--heatmap-green))] text-white";
                          else if (cell.color === "amber")
                            bgColor = "bg-[hsl(var(--heatmap-amber))] text-amber-950";
                          else if (cell.color === "red")
                            bgColor = "bg-[hsl(var(--heatmap-red))] text-white";

                          let woiDisplay = "—";
                          if (cell.woi !== null) {
                            woiDisplay = String(Math.round(cell.woi));
                          } else if (cell.st === 0 && cell.soh > 0) {
                            woiDisplay = "∞";
                          }

                          return (
                            <div
                              key={res}
                              className={`p-1 border-b bg-card group-hover:bg-muted/50 transition-colors
                                ${colOver ? "bg-primary/5" : ""}
                                ${colDragging ? "opacity-40" : ""}
                              `}
                            >
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div
                                    className={`h-8 rounded flex items-center justify-center text-xs font-medium cursor-default shadow-xs ${bgColor}`}
                                  >
                                    {woiDisplay}
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="text-xs">
                                  <div className="font-semibold mb-1.5">
                                    {part} @ {res}
                                  </div>
                                  <div className="space-y-1">
                                    <div>
                                      SOH:{" "}
                                      <span className="font-bold">
                                        {cell.soh.toLocaleString()}
                                      </span>{" "}
                                      units
                                    </div>
                                    <div>
                                      Avg ST:{" "}
                                      <span className="font-bold">
                                        {cell.st.toLocaleString()}
                                      </span>{" "}
                                      units/wk
                                    </div>
                                    <div>
                                      WOI:{" "}
                                      <span className="font-bold">{woiDisplay}</span>{" "}
                                      weeks
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
        </Card>
      </div>
    </div>
  );
}
