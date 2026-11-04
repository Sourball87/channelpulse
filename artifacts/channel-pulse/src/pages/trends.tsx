import { formatWeekLabel, formatWeekRange } from "@/lib/week-display";
import { useState, useMemo } from "react";
import { useGetTrends, GetTrendsMetric } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, Filter } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer } from "recharts";
import { useFilters } from "@/context/filter-context";

const WEEKS_OPTIONS = [
  { label: "Last 4 Weeks",  value: "4" },
  { label: "Last 8 Weeks",  value: "8" },
  { label: "Last 12 Weeks", value: "12" },
  { label: "Last 26 Weeks", value: "26" },
];

const COLORS = [
  "hsl(var(--chart-1))", "hsl(var(--chart-2))", "hsl(var(--chart-3))", 
  "hsl(var(--chart-4))", "hsl(var(--chart-5))", "hsl(var(--primary))",
  "hsl(var(--destructive))", "hsl(var(--heatmap-amber))",
];

export default function Trends() {
  const [weeks, setWeeks] = useState("12");
  const [metric, setMetric] = useState<GetTrendsMetric>("soh");

  const { apiParams, partIds, resellerIds, mode, periodLabel } = useFilters();

  // In period mode the x-axis range comes from the global filter.
  // In single-week mode we use the lookback `weeks` param.
  const queryParams = mode === "period"
    ? { ...apiParams, metric }
    : { ...apiParams, weeks: parseInt(weeks, 10), metric };

  const hasSelection = partIds.length > 0 || resellerIds.length > 0;

  const { data: trendSeries, isLoading } = useGetTrends(queryParams, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: { enabled: hasSelection } as any,
  });

  const chartData = useMemo(() => {
    if (!trendSeries || trendSeries.length === 0) return [];
    const allWeeks = new Set<string>();
    trendSeries.forEach(s => s.points.forEach(pt => allWeeks.add(pt.week_iso)));
    return Array.from(allWeeks).sort().map(w => {
      const point: Record<string, unknown> = { week_iso: w };
      trendSeries.forEach(s => {
        const match = s.points.find(pt => pt.week_iso === w);
        point[s.key] = match ? match[metric as keyof typeof match] : null;
      });
      return point;
    });
  }, [trendSeries, metric]);

  return (
    <div className="flex flex-col h-full bg-muted/10">
      <header className="flex-none bg-background border-b px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Trend Analysis</h1>
          <p className="text-sm text-muted-foreground">
            {mode === "period" ? `Period: ${periodLabel}` : "Compare performance across time"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={metric} onValueChange={(v) => setMetric(v as GetTrendsMetric)}>
            <SelectTrigger className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="soh">Stock on Hand (SOH)</SelectItem>
              <SelectItem value="st">Sell-Through (ST)</SelectItem>
              <SelectItem value="woi">Weeks of Inventory (WOI)</SelectItem>
            </SelectContent>
          </Select>

          {mode !== "period" && (
            <Select value={weeks} onValueChange={setWeeks}>
              <SelectTrigger className="w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WEEKS_OPTIONS.map(o => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </header>

      <div className="flex-1 flex flex-col min-w-0 p-6">
        <Card className="flex-1 shadow-sm flex flex-col min-h-0">
          <CardHeader className="border-b px-6 py-4 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">
              {metric === "soh" ? "Stock on Hand" : metric === "st" ? "Sell-Through" : "Weeks of Inventory"}
            </CardTitle>
            <div className="flex gap-2 items-center">
              {partIds.length > 0 && <Badge variant="secondary">{partIds.length} model{partIds.length > 1 ? "s" : ""}</Badge>}
              {resellerIds.length > 0 && <Badge variant="secondary">{resellerIds.length} customer{resellerIds.length > 1 ? "s" : ""}</Badge>}
              {mode === "period" && <Badge variant="outline" className="text-xs">{periodLabel}</Badge>}
            </div>
          </CardHeader>
          <CardContent className="flex-1 p-6 min-h-0">
            {!hasSelection ? (
              <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
                <TrendingUp className="h-12 w-12 mb-4 opacity-20" />
                <p className="font-medium">No models or customers selected</p>
                <p className="text-sm mt-1 flex items-center gap-1.5">
                  <Filter className="h-4 w-4" /> Use the filter bar above to select models and/or customers.
                </p>
              </div>
            ) : isLoading ? (
              <div className="h-full w-full flex items-center justify-center">
                <Skeleton className="h-[90%] w-[95%]" />
              </div>
            ) : !trendSeries || trendSeries.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
                <p>No data found for this selection.</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="week_iso" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} dy={10} height={64} minTickGap={35}
                    tickFormatter={week => `${String(week).slice(5)} · ${formatWeekRange(String(week))}`} angle={-15} textAnchor="end" />
                  <YAxis tick={{ fontSize: 12 }} tickLine={false} axisLine={false} dx={-10} />
                  <RechartsTooltip 
                    labelFormatter={label => formatWeekLabel(String(label))}
                    contentStyle={{ backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--border))", borderRadius: "6px", fontSize: "12px" }}
                    labelStyle={{ fontWeight: "bold", marginBottom: "4px" }}
                  />
                  <Legend wrapperStyle={{ fontSize: "12px", paddingTop: "20px" }} />
                  {trendSeries.map((series, idx) => (
                    <Line 
                      key={series.key} 
                      type="monotone" 
                      dataKey={series.key} 
                      name={series.label} 
                      stroke={COLORS[idx % COLORS.length]} 
                      strokeWidth={2}
                      dot={{ r: 4, strokeWidth: 2 }}
                      activeDot={{ r: 6 }}
                      connectNulls={false}
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
