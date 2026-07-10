import { useState, useMemo } from "react";
import { 
  useGetTrends, 
  useGetParts, 
  useGetResellers,
  GetTrendsMetric
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, X, TrendingUp } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer } from "recharts";

const WEEKS_OPTIONS = [
  { label: "Last 4 Weeks", value: "4" },
  { label: "Last 8 Weeks", value: "8" },
  { label: "Last 12 Weeks", value: "12" },
  { label: "Last 26 Weeks", value: "26" },
];

export default function Trends() {
  const [weeks, setWeeks] = useState("12");
  const [metric, setMetric] = useState<GetTrendsMetric>("soh");
  const [selectedParts, setSelectedParts] = useState<Set<number>>(new Set());
  const [selectedResellers, setSelectedResellers] = useState<Set<number>>(new Set());
  
  const [partSearch, setPartSearch] = useState("");
  const [resellerSearch, setResellerSearch] = useState("");

  const { data: parts } = useGetParts();
  const { data: resellers } = useGetResellers();

  const queryParts = Array.from(selectedParts).join(',');
  const queryResellers = Array.from(selectedResellers).join(',');

  const { data: trendSeries, isLoading } = useGetTrends({
    part_ids: queryParts || undefined,
    reseller_ids: queryResellers || undefined,
    weeks: parseInt(weeks, 10),
    metric
  }, { query: { enabled: selectedParts.size > 0 || selectedResellers.size > 0 } });

  const filteredParts = useMemo(() => {
    if (!parts) return [];
    if (!partSearch) return parts.slice(0, 100); // Limit to 100 to avoid freezing
    const q = partSearch.toLowerCase();
    return parts.filter(p => p.part_no.toLowerCase().includes(q) || p.display_name?.toLowerCase().includes(q)).slice(0, 100);
  }, [parts, partSearch]);

  const filteredResellers = useMemo(() => {
    if (!resellers) return [];
    if (!resellerSearch) return resellers;
    const q = resellerSearch.toLowerCase();
    return resellers.filter(r => r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q));
  }, [resellers, resellerSearch]);

  const togglePart = (id: number) => {
    const next = new Set(selectedParts);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedParts(next);
  };

  const toggleReseller = (id: number) => {
    const next = new Set(selectedResellers);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedResellers(next);
  };

  const clearFilters = () => {
    setSelectedParts(new Set());
    setSelectedResellers(new Set());
  };

  const colors = [
    "hsl(var(--chart-1))", "hsl(var(--chart-2))", "hsl(var(--chart-3))", 
    "hsl(var(--chart-4))", "hsl(var(--chart-5))", "hsl(var(--primary))",
    "hsl(var(--destructive))", "hsl(var(--heatmap-amber))"
  ];

  // Transform trendSeries to recharts format
  // Recharts wants array of objects: { week_iso: '2023-W01', "Series1": 10, "Series2": 20 }
  const chartData = useMemo(() => {
    if (!trendSeries || trendSeries.length === 0) return [];
    
    // Get all unique weeks across all series
    const allWeeks = new Set<string>();
    trendSeries.forEach(series => {
      series.points.forEach(pt => allWeeks.add(pt.week_iso));
    });
    
    const sortedWeeks = Array.from(allWeeks).sort();
    
    return sortedWeeks.map(w => {
      const point: any = { week_iso: w };
      trendSeries.forEach(series => {
        const match = series.points.find(pt => pt.week_iso === w);
        point[series.key] = match ? match[metric as keyof typeof match] : null;
      });
      return point;
    });
  }, [trendSeries, metric]);

  return (
    <div className="flex h-full bg-background">
      {/* Sidebar Filters */}
      <div className="w-80 border-r flex flex-col h-full bg-card shrink-0">
        <div className="p-4 border-b">
          <h2 className="font-semibold flex items-center gap-2">
            <TrendingUp className="h-4 w-4" /> Trend Parameters
          </h2>
        </div>
        
        <div className="p-4 flex flex-col gap-4 overflow-hidden flex-1">
          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground uppercase">Metric</label>
            <Select value={metric} onValueChange={(v) => setMetric(v as GetTrendsMetric)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="soh">Stock on Hand (SOH)</SelectItem>
                <SelectItem value="st">Sell-Through (ST)</SelectItem>
                <SelectItem value="woi">Weeks of Inventory (WOI)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground uppercase">Timeframe</label>
            <Select value={weeks} onValueChange={setWeeks}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WEEKS_OPTIONS.map(o => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2 flex-1 flex flex-col min-h-0">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-muted-foreground uppercase">Models ({selectedParts.size})</label>
              {selectedParts.size > 0 && (
                <Button variant="ghost" size="sm" className="h-6 text-xs px-2" onClick={() => setSelectedParts(new Set())}>Clear</Button>
              )}
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
              <Input 
                placeholder="Search parts..." 
                value={partSearch} 
                onChange={(e) => setPartSearch(e.target.value)} 
                className="pl-8 h-8"
              />
            </div>
            <ScrollArea className="flex-1 border rounded-md p-2">
              <div className="space-y-1">
                {filteredParts.map(p => (
                  <label key={p.id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-muted/50 rounded-sm cursor-pointer">
                    <Checkbox checked={selectedParts.has(p.id)} onCheckedChange={() => togglePart(p.id)} />
                    <div className="grid gap-0.5 leading-none w-full">
                      <span className="text-sm font-medium leading-none truncate">{p.part_no}</span>
                      {p.display_name && <span className="text-xs text-muted-foreground truncate">{p.display_name}</span>}
                    </div>
                  </label>
                ))}
              </div>
            </ScrollArea>
          </div>

          <div className="space-y-2 flex-1 flex flex-col min-h-0">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-muted-foreground uppercase">Resellers ({selectedResellers.size})</label>
              {selectedResellers.size > 0 && (
                <Button variant="ghost" size="sm" className="h-6 text-xs px-2" onClick={() => setSelectedResellers(new Set())}>Clear</Button>
              )}
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
              <Input 
                placeholder="Search resellers..." 
                value={resellerSearch} 
                onChange={(e) => setResellerSearch(e.target.value)} 
                className="pl-8 h-8"
              />
            </div>
            <ScrollArea className="flex-1 border rounded-md p-2">
              <div className="space-y-1">
                {filteredResellers.map(r => (
                  <label key={r.id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-muted/50 rounded-sm cursor-pointer">
                    <Checkbox checked={selectedResellers.has(r.id)} onCheckedChange={() => toggleReseller(r.id)} />
                    <span className="text-sm font-medium leading-none truncate">{r.name}</span>
                  </label>
                ))}
              </div>
            </ScrollArea>
          </div>
        </div>
      </div>

      {/* Chart Area */}
      <div className="flex-1 flex flex-col min-w-0 p-6 bg-muted/10">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Trend Analysis</h1>
            <p className="text-sm text-muted-foreground">Compare performance across time, products, and partners</p>
          </div>
        </div>

        <Card className="flex-1 shadow-sm flex flex-col">
          <CardHeader className="border-b px-6 py-4 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">
              {metric === 'soh' ? 'Stock on Hand' : metric === 'st' ? 'Sell-Through' : 'Weeks of Inventory'}
            </CardTitle>
            <div className="flex gap-2">
              {selectedParts.size > 0 && <Badge variant="secondary">{selectedParts.size} parts</Badge>}
              {selectedResellers.size > 0 && <Badge variant="secondary">{selectedResellers.size} resellers</Badge>}
            </div>
          </CardHeader>
          <CardContent className="flex-1 p-6">
            {selectedParts.size === 0 && selectedResellers.size === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
                <TrendingUp className="h-12 w-12 mb-4 opacity-20" />
                <p>Select at least one part or reseller to view trends.</p>
              </div>
            ) : isLoading ? (
              <div className="h-full w-full flex items-center justify-center">
                <Skeleton className="h-[90%] w-[95%]" />
              </div>
            ) : !trendSeries || trendSeries.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
                <p>No data found for the selected combination.</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="week_iso" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} dy={10} />
                  <YAxis tick={{ fontSize: 12 }} tickLine={false} axisLine={false} dx={-10} />
                  <RechartsTooltip 
                    contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))', borderRadius: '6px', fontSize: '12px' }}
                    labelStyle={{ fontWeight: 'bold', marginBottom: '4px' }}
                  />
                  <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '20px' }} />
                  {trendSeries.map((series, idx) => (
                    <Line 
                      key={series.key} 
                      type="monotone" 
                      dataKey={series.key} 
                      name={series.label} 
                      stroke={colors[idx % colors.length]} 
                      strokeWidth={2}
                      dot={{ r: 4, strokeWidth: 2 }}
                      activeDot={{ r: 6 }}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
