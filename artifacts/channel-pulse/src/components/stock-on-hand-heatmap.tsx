import { useGetDashboardHeatmap, useGetResellers } from "@workspace/api-client-react";
import { useFilters } from "@/context/filter-context";
import { sortByOrder, useHeatmapOrder } from "@/hooks/use-heatmap-order";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** A point-in-time stock view; period filters select their ending week, never sum stock. */
export function StockOnHandHeatmap({ category }: { category?: string }) {
  const { apiParams, insightWeek, resellerIds, setFocusView } = useFilters();
  const stockParams = {
    week_iso: insightWeek,
    category,
    part_ids: apiParams.part_ids,
    reseller_ids: apiParams.reseller_ids,
  };
  const { data, isLoading, isError, refetch } = useGetDashboardHeatmap(stockParams);
  const { data: accounts } = useGetResellers();
  const { partOrder, resellerOrder } = useHeatmapOrder();
  const stocks = sortByOrder(data?.parts ?? [], partOrder);
  // Include non-reporting accounts as empty columns, not false zero stock.
  const accountCodes = accounts
    ? accounts.filter(account => !resellerIds.length || resellerIds.includes(account.id)).map(account => account.code)
    : data?.resellers ?? [];
  const columns = sortByOrder(accountCodes, resellerOrder);
  const cells = new Map((data?.cells ?? []).map(cell => [`${cell.part_no}:${cell.reseller_code}`, cell]));
  const maxStock = (data?.cells ?? []).reduce((max, cell) => Math.max(max, cell.soh), 0);

  return (
    <Card className="shadow-xs min-w-0" data-testid="soh-heatmap">
      <CardHeader className="px-4 py-3 border-b bg-muted/10 flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-sm font-medium flex flex-wrap items-center gap-2">
          Stock on Hand (SOH)
          <Badge variant="secondary">{data?.week_iso ?? insightWeek ?? "Latest week"}</Badge>
        </CardTitle>
        <Button variant="outline" size="sm" onClick={() => setFocusView(true)}>
          Open Phocas sell-through
        </Button>
      </CardHeader>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground mb-3">
          Stock Code by Account Code · Stock units for the selected reporting week.
          {" "}For a date range, SOH uses the ending week.
        </p>
        {isLoading ? <Skeleton className="h-64 w-full" /> : isError ? (
          <div className="py-8 text-center space-y-2">
            <p>Could not load stock on hand.</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>Try again</Button>
          </div>
        ) : !stocks.length ? (
          <p className="py-8 text-center text-muted-foreground">No SOH reports for this week and selection.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground mb-3">
              <span>0 units</span>
              <span className="h-3 w-28 rounded bg-gradient-to-r from-[#eff1f3] to-[#2672a6]" aria-hidden="true" />
              <span>{maxStock.toLocaleString()} units</span>
              <span className="ml-2">— No reported data</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-separate border-spacing-0" aria-label="Stock on hand by Stock Code and Account Code">
                <thead>
                  <tr>
                    <th scope="col" className="sticky left-0 z-20 bg-card text-left font-semibold text-muted-foreground p-2 border-b min-w-[152px]">
                      Stock Code
                    </th>
                    {columns.map(code => (
                      <th key={code} scope="col" className="text-center font-semibold text-muted-foreground p-2 border-b min-w-[76px]">{code}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {stocks.map(stock => (
                    <tr key={stock} className="group">
                      <th scope="row" className="sticky left-0 z-10 bg-card text-left font-medium p-2 border-b whitespace-nowrap">{stock}</th>
                      {columns.map(code => {
                        const cell = cells.get(`${stock}:${code}`);
                        if (!cell) return (
                          <td key={code} className="p-1 border-b text-center text-muted-foreground" aria-label={`${stock} at ${code}: no reported data`}>—</td>
                        );
                        const intensity = maxStock > 0 ? Math.max(0, Math.min(1, cell.soh / maxStock)) : 0;
                        const backgroundColor = `rgb(${Math.round(239 - 201 * intensity)}, ${Math.round(241 - 127 * intensity)}, ${Math.round(243 - 77 * intensity)})`;
                        return (
                          <td key={code} className="p-1 border-b">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div
                                  className={`h-8 rounded flex items-center justify-center font-medium ${intensity > 0.55 ? "text-white" : "text-slate-900"}`}
                                  style={{ backgroundColor }}
                                  aria-label={`${stock} at ${code}: ${cell.soh.toLocaleString()} units on hand`}
                                >{cell.soh.toLocaleString()}</div>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>{stock} · {code} · {data?.week_iso}</p>
                                <p>Stock on hand: {cell.soh.toLocaleString()} units</p>
                              </TooltipContent>
                            </Tooltip>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
