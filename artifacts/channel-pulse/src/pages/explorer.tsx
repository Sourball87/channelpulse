import { useState, useMemo, useCallback } from "react";
import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry } from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-alpine.css";

ModuleRegistry.registerModules([AllCommunityModule]);
import { useGetExplorerData, useGetExplorerTrend, useGetAvailableWeeks } from "@workspace/api-client-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, LayoutList, ArrowUp, ArrowDown, X, BarChart2 } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer, ComposedChart } from "recharts";
import { Badge } from "@/components/ui/badge";

const CATEGORIES = ["All", "SSD", "Monitor", "Mobility", "HDD & Memory"];

function ValueWithDelta({ value, delta }: { value: number | null | undefined, delta: number | null | undefined }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>;
  
  return (
    <div className="flex items-center gap-2 justify-end w-full">
      <span>{value.toLocaleString()}</span>
      {delta !== null && delta !== undefined && delta !== 0 && (
        <span className={`text-[10px] flex items-center ${delta > 0 ? "text-emerald-500" : "text-rose-500"}`}>
          {delta > 0 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
          {Math.abs(delta)}
        </span>
      )}
    </div>
  );
}

export default function Explorer() {
  const [week, setWeek] = useState<string>("latest");
  const [category, setCategory] = useState<string>("All");
  const [pivot, setPivot] = useState<"category_model_reseller" | "reseller_model">("category_model_reseller");
  
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedRow, setSelectedRow] = useState<any>(null);

  const { data: weeks } = useGetAvailableWeeks();
  const queryWeek = week === "latest" && weeks?.length ? weeks[0].week_iso : week !== "latest" ? week : undefined;
  const queryCategory = category === "All" ? undefined : category;

  const { data: rows, isLoading } = useGetExplorerData({ 
    week_iso: queryWeek, 
    category: queryCategory,
    pivot
  });

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const visibleRows = useMemo(() => {
    if (!rows) return [];
    return rows.filter(row => {
      if (!row.parent_id) return true;
      let parent = rows.find(r => r.id === row.parent_id);
      while (parent) {
        if (!expandedIds.has(parent.id)) return false;
        parent = parent.parent_id ? rows.find(r => r.id === parent?.parent_id) : undefined;
      }
      return true;
    });
  }, [rows, expandedIds]);

  const hasChildren = useCallback((id: string) => {
    return rows?.some(r => r.parent_id === id) || false;
  }, [rows]);

  const colDefs = useMemo(() => [
    { 
      field: "label", 
      headerName: "Hierarchy", 
      flex: 2,
      cellRenderer: (params: any) => {
        const row = params.data;
        const isExpanded = expandedIds.has(row.id);
        const childrenExist = hasChildren(row.id);
        const padLeft = row.level === 'category' || row.level === 'reseller' && pivot === 'reseller_model' ? 0 : 
                        row.level === 'model' ? 24 : 48;
        
        return (
          <div 
            className="flex items-center gap-1 cursor-pointer w-full h-full"
            style={{ paddingLeft: `${padLeft}px` }}
            onClick={() => childrenExist ? toggleExpand(row.id) : setSelectedRow(row)}
          >
            {childrenExist ? (
              <span className="text-muted-foreground hover:text-foreground">
                {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </span>
            ) : <span className="w-4" />}
            <span className={row.level === 'category' || (row.level === 'reseller' && pivot === 'reseller_model') ? "font-semibold" : ""}>
              {row.label}
            </span>
            {!childrenExist && (
              <BarChart2 className="h-3 w-3 ml-2 text-muted-foreground opacity-0 group-hover:opacity-100" />
            )}
          </div>
        );
      }
    },
    { field: "level", headerName: "Level", width: 100 },
    { 
      headerName: "SOH", 
      field: "soh",
      width: 120,
      cellRenderer: (params: any) => <ValueWithDelta value={params.data.soh} delta={params.data.soh_delta} />
    },
    { 
      headerName: "ST", 
      field: "st",
      width: 120,
      cellRenderer: (params: any) => <ValueWithDelta value={params.data.st} delta={params.data.st_delta} />
    },
    { 
      headerName: "WOI", 
      field: "woi",
      width: 100,
      cellRenderer: (params: any) => {
        const val = params.value;
        if (val === null || val === undefined) return <span className="text-muted-foreground">—</span>;
        let color = "text-foreground";
        if (val <= 8) color = "text-[hsl(var(--heatmap-green))]";
        else if (val <= 15) color = "text-amber-600 dark:text-amber-500";
        else color = "text-[hsl(var(--heatmap-red))]";
        return <div className={`text-right w-full font-medium ${color}`}>{val.toFixed(1)}</div>;
      }
    },
    { 
      headerName: "Sold MTD", 
      field: "sold_mtd",
      width: 100,
      cellRenderer: (params: any) => <div className="text-right w-full">{params.value?.toLocaleString() || '—'}</div>
    },
    { 
      headerName: "On Order", 
      field: "on_order",
      width: 100,
      cellRenderer: (params: any) => <div className="text-right w-full">{params.value?.toLocaleString() || '—'}</div>
    }
  ], [expandedIds, hasChildren, toggleExpand, pivot]);

  // Trend Panel
  const { data: trendData, isLoading: isLoadingTrend } = useGetExplorerTrend(
    { part_id: selectedRow?.part_id, reseller_id: selectedRow?.reseller_id, weeks: 12 },
    { query: { enabled: !!selectedRow } }
  );

  return (
    <div className="flex flex-col h-full bg-background">
      <header className="flex-none border-b px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Explorer</h1>
          <p className="text-sm text-muted-foreground">Drill down through inventory hierarchy</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex bg-muted p-1 rounded-md">
            <Button 
              variant={pivot === "category_model_reseller" ? "secondary" : "ghost"} 
              size="sm"
              onClick={() => setPivot("category_model_reseller")}
              className="text-xs h-7"
            >
              Cat → Model → Reseller
            </Button>
            <Button 
              variant={pivot === "reseller_model" ? "secondary" : "ghost"} 
              size="sm"
              onClick={() => setPivot("reseller_model")}
              className="text-xs h-7"
            >
              Reseller → Model
            </Button>
          </div>

          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={week} onValueChange={setWeek}>
            <SelectTrigger className="w-[160px]">
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

      <div className="flex-1 p-6 relative">
        <div className="h-full border rounded-md overflow-hidden bg-card shadow-sm ag-theme-alpine w-full">
          {isLoading ? (
            <div className="p-8 space-y-4">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-[80%]" />
              <Skeleton className="h-8 w-[90%]" />
            </div>
          ) : (
            <AgGridReact
              rowData={visibleRows}
              columnDefs={colDefs}
              animateRows={true}
              rowHeight={40}
              headerHeight={40}
              suppressCellFocus={true}
              getRowClass={(params) => `group ${params.data.level === 'category' || (params.data.level === 'reseller' && pivot === 'reseller_model') ? 'bg-muted/30' : ''}`}
            />
          )}
        </div>
      </div>

      <Sheet open={!!selectedRow} onOpenChange={(open) => !open && setSelectedRow(null)}>
        <SheetContent className="w-[500px] sm:w-[600px] border-l p-0 flex flex-col">
          <SheetHeader className="p-6 border-b bg-muted/20">
            <div className="flex items-start justify-between">
              <div>
                <SheetTitle className="text-lg">{selectedRow?.label}</SheetTitle>
                <SheetDescription className="mt-1">
                  12-Week Trend Analysis
                </SheetDescription>
              </div>
              <div className="flex gap-2">
                {selectedRow?.level && <Badge variant="outline">{selectedRow.level}</Badge>}
                {selectedRow?.category && <Badge variant="secondary">{selectedRow.category}</Badge>}
              </div>
            </div>
          </SheetHeader>
          
          <div className="flex-1 p-6 overflow-y-auto">
            {isLoadingTrend ? (
              <div className="space-y-4">
                <Skeleton className="h-[300px] w-full" />
                <div className="grid grid-cols-2 gap-4">
                  <Skeleton className="h-24 w-full" />
                  <Skeleton className="h-24 w-full" />
                </div>
              </div>
            ) : trendData && trendData.length > 0 ? (
              <div className="space-y-8">
                <div className="h-[350px] w-full border rounded-lg p-4 pt-6 bg-card shadow-sm">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={trendData.slice().reverse()} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="week_iso" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                      <YAxis yAxisId="left" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                      <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                      <RechartsTooltip 
                        contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))', borderRadius: '6px', fontSize: '12px' }}
                      />
                      <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                      <Bar yAxisId="left" dataKey="soh" name="SOH" fill="hsl(var(--chart-2))" radius={[2, 2, 0, 0]} barSize={20} />
                      <Line yAxisId="left" type="monotone" dataKey="st" name="ST" stroke="hsl(var(--chart-1))" strokeWidth={2} dot={{ r: 3 }} />
                      <Line yAxisId="right" type="stepAfter" dataKey="woi" name="WOI" stroke="hsl(var(--chart-5))" strokeWidth={2} strokeDasharray="4 4" dot={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                  <div className="border rounded-lg p-4 bg-muted/20">
                    <div className="text-sm font-medium text-muted-foreground mb-1">Latest SOH</div>
                    <div className="text-2xl font-bold">{selectedRow?.soh?.toLocaleString() || 0}</div>
                  </div>
                  <div className="border rounded-lg p-4 bg-muted/20">
                    <div className="text-sm font-medium text-muted-foreground mb-1">Latest ST</div>
                    <div className="text-2xl font-bold">{selectedRow?.st?.toLocaleString() || 0}</div>
                  </div>
                  <div className="border rounded-lg p-4 bg-muted/20">
                    <div className="text-sm font-medium text-muted-foreground mb-1">Sold MTD</div>
                    <div className="text-2xl font-bold">{selectedRow?.sold_mtd?.toLocaleString() || 0}</div>
                  </div>
                  <div className="border rounded-lg p-4 bg-muted/20">
                    <div className="text-sm font-medium text-muted-foreground mb-1">On Order</div>
                    <div className="text-2xl font-bold">{selectedRow?.on_order?.toLocaleString() || 0}</div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-[300px] text-muted-foreground">
                <BarChart2 className="h-12 w-12 mb-4 opacity-20" />
                <p>No trend data available for this selection.</p>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
