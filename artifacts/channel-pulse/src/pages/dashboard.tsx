import { useState, useMemo } from "react";
import { Link } from "wouter";
import { 
  useGetDashboardKpis, 
  useGetDashboardHeatmap, 
  useGetAvailableWeeks 
} from "@workspace/api-client-react";
import { 
  Select, 
  SelectContent, 
  SelectItem, 
  SelectTrigger, 
  SelectValue 
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, ArrowDown, ArrowRight, ArrowUp, Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const CATEGORIES = ["All", "SSD", "Monitor", "Mobility", "HDD & Memory"];

export default function Dashboard() {
  const [week, setWeek] = useState<string>("latest");
  const [category, setCategory] = useState<string>("All");

  const { data: weeks } = useGetAvailableWeeks();
  
  const queryWeek = week === "latest" && weeks?.length ? weeks[0].week_iso : week !== "latest" ? week : undefined;
  const queryCategory = category === "All" ? undefined : category;

  const { data: kpiData, isLoading: isLoadingKpis } = useGetDashboardKpis({ 
    week_iso: queryWeek, 
    category: queryCategory 
  });
  
  const { data: heatmapData, isLoading: isLoadingHeatmap } = useGetDashboardHeatmap({ 
    week_iso: queryWeek, 
    category: queryCategory 
  });

  const reportedCount = kpiData?.reseller_statuses.filter(r => r.reported).length || 0;
  const totalResellers = kpiData?.reseller_statuses.length || 9;

  return (
    <div className="flex flex-col h-full bg-muted/20">
      <header className="flex-none bg-background border-b px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">SOH and Sell-Through Overview</p>
        </div>
        <div className="flex items-center gap-4">
          <Tabs value={category} onValueChange={setCategory} className="w-auto">
            <TabsList>
              {CATEGORIES.map(c => (
                <TabsTrigger key={c} value={c} className="text-xs px-3">
                  {c}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          
          <Select value={week} onValueChange={setWeek}>
            <SelectTrigger className="w-[180px] bg-background">
              <SelectValue placeholder="Select week" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="latest">Latest Week</SelectItem>
              {weeks?.map((w) => (
                <SelectItem key={w.week_iso} value={w.week_iso}>
                  {w.week_iso}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-6 space-y-6">
        <div className="grid grid-cols-4 gap-4">
          {isLoadingKpis ? (
            Array.from({ length: 4 }).map((_, i) => (
              <Card key={i} className="shadow-xs">
                <CardHeader className="p-4 pb-2"><Skeleton className="h-4 w-24" /></CardHeader>
                <CardContent className="p-4 pt-0"><Skeleton className="h-8 w-32" /></CardContent>
              </Card>
            ))
          ) : kpiData?.kpis.map((kpi) => (
            <Card key={kpi.label} className="shadow-xs">
              <CardHeader className="p-4 pb-2 flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-sm font-medium text-muted-foreground">{kpi.label}</CardTitle>
                {kpi.delta_direction === 'up' && <ArrowUp className="h-4 w-4 text-emerald-500" />}
                {kpi.delta_direction === 'down' && <ArrowDown className="h-4 w-4 text-rose-500" />}
                {kpi.delta_direction === 'flat' && <ArrowRight className="h-4 w-4 text-muted-foreground" />}
              </CardHeader>
              <CardContent className="p-4 pt-0">
                <div className="text-2xl font-bold">{kpi.formatted || kpi.value?.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                  <span className={
                    kpi.delta_direction === 'up' ? "text-emerald-500 font-medium" : 
                    kpi.delta_direction === 'down' ? "text-rose-500 font-medium" : ""
                  }>
                    {kpi.delta_pct != null ? `${kpi.delta_pct > 0 ? '+' : ''}${kpi.delta_pct.toFixed(1)}%` : '0%'}
                  </span>
                  <span> vs last week</span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card className="shadow-xs">
          <CardHeader className="px-4 py-3 border-b bg-muted/10 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm font-medium">Reporting Status: {kpiData?.week_iso || "Week"}</CardTitle>
            <Badge variant={reportedCount === totalResellers ? "default" : "secondary"}>
              {reportedCount} of {totalResellers} Reported
            </Badge>
          </CardHeader>
          <CardContent className="p-0">
            <div className="flex gap-1 p-2 overflow-x-auto">
              {kpiData?.reseller_statuses.map(reseller => (
                <div 
                  key={reseller.reseller_id} 
                  className={`flex-1 min-w-[80px] text-center p-2 rounded-md border text-xs font-medium ${
                    reseller.reported ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-700 dark:text-emerald-400" : "bg-muted border-border text-muted-foreground"
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
          </CardHeader>
          <CardContent className="p-0 overflow-auto flex-1">
            {isLoadingHeatmap ? (
              <div className="p-8 flex items-center justify-center h-full">
                <Skeleton className="h-full w-full" />
              </div>
            ) : !heatmapData || heatmapData.parts.length === 0 ? (
              <div className="p-8 flex flex-col items-center justify-center h-full text-muted-foreground">
                <AlertCircle className="h-8 w-8 mb-2 opacity-50" />
                <p>No data available for this week/category.</p>
              </div>
            ) : (
              <div className="inline-block min-w-full relative p-4">
                <div 
                  className="grid gap-1"
                  style={{ 
                    gridTemplateColumns: `minmax(180px, max-content) repeat(${heatmapData.resellers.length}, minmax(60px, 1fr))` 
                  }}
                >
                  {/* Header Row */}
                  <div className="sticky top-0 left-0 z-20 bg-card p-2 text-xs font-semibold text-muted-foreground border-b shadow-[1px_0_0_hsl(var(--border))]">
                    Part / Reseller
                  </div>
                  {heatmapData.resellers.map(res => (
                    <div key={res} className="sticky top-0 z-10 bg-card p-2 text-xs font-semibold text-center border-b text-muted-foreground">
                      {res}
                    </div>
                  ))}

                  {/* Data Rows */}
                  {heatmapData.parts.map(part => {
                    const rowCells = heatmapData.cells.filter(c => c.part_no === part);
                    // Create a lookup for quick access
                    const cellMap = new Map(rowCells.map(c => [c.reseller_code, c]));
                    
                    return (
                      <div className="contents group" key={part}>
                        <div className="sticky left-0 z-10 bg-card p-2 text-xs font-medium border-b flex items-center group-hover:bg-muted/50 shadow-[1px_0_0_hsl(var(--border))] transition-colors">
                          <span className="truncate" title={rowCells[0]?.display_name || part}>
                            {part}
                          </span>
                        </div>
                        {heatmapData.resellers.map(res => {
                          const cell = cellMap.get(res);
                          if (!cell || cell.color === 'empty') {
                            return <div key={res} className="p-1 border-b bg-card group-hover:bg-muted/50 transition-colors" />;
                          }

                          let bgColor = "bg-muted text-muted-foreground";
                          if (cell.color === 'green') bgColor = "bg-[hsl(var(--heatmap-green))] text-white";
                          else if (cell.color === 'amber') bgColor = "bg-[hsl(var(--heatmap-amber))] text-amber-950";
                          else if (cell.color === 'red') bgColor = "bg-[hsl(var(--heatmap-red))] text-white";

                          let woiDisplay = "—";
                          if (cell.woi !== null) {
                            woiDisplay = String(Math.round(cell.woi));
                          } else if (cell.st === 0 && cell.soh > 0) {
                            woiDisplay = "∞";
                          }

                          return (
                            <div key={res} className="p-1 border-b bg-card group-hover:bg-muted/50 transition-colors">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div className={`h-8 rounded flex items-center justify-center text-xs font-medium cursor-default shadow-xs ${bgColor}`}>
                                    {woiDisplay}
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent side="top">
                                  <div className="text-xs space-y-1">
                                    <div className="font-semibold">{part} @ {res}</div>
                                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2">
                                      <span className="text-muted-foreground">SOH:</span>
                                      <span className="font-medium">{cell.soh.toLocaleString()}</span>
                                      <span className="text-muted-foreground">ST:</span>
                                      <span className="font-medium">{cell.st.toLocaleString()}</span>
                                      <span className="text-muted-foreground">WOI:</span>
                                      <span className="font-medium">{woiDisplay}</span>
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
