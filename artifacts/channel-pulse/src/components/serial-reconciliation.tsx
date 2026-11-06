import { useMemo } from "react";
import {
  useGetSerialReconciliation,
  getGetSerialReconciliationQueryKey,
  type SerialReconciliationRow,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AlertCircle, Info, ScanBarcode, ShieldAlert } from "lucide-react";
import { formatWeekLabel, formatWeekRange } from "@/lib/week-display";
import { customerLabel } from "@/lib/customer-display";
import { serialReportDisplay, selectReconciliationWeek } from "@/lib/serial-report-display";

interface Props {
  week?: string;
  windowWeeks?: string[];
  onWeekChange: (week: string) => void;
  partIds?: string;
  resellerIds?: string;
  category?: string;
  enabled: boolean;
}

const dash = <span className="text-muted-foreground">—</span>;
const num = (n: number) => n.toLocaleString();

export function SourceTag({ source, title }: { source: "soh" | "serials"; title?: string }) {
  return (
    <span
      title={title ?? (source === "serials" ? "Sell-through counted from weekly serial reports (SOH file had no sold column)" : "Sell-through from SOH file sold column")}
      className={`inline-flex items-center rounded-sm px-1 py-px font-mono text-[9px] uppercase leading-none tracking-wide ${
        source === "serials" ? "bg-violet-100 text-violet-800 ring-1 ring-violet-300" : "bg-slate-100 text-slate-600 ring-1 ring-slate-200"
      }`}
    >
      {source}
    </span>
  );
}

function SerialsCell({ r }: { r: SerialReconciliationRow }) {
  const display = serialReportDisplay(r);
  if (display.kind === "count") return <span className="font-mono">{num(display.count)}</span>;
  if (display.kind === "not-expected") return <span className="text-xs text-muted-foreground italic">Not expected</span>;
  return <span className="text-xs font-medium text-amber-700">{r.serial_report_received ? "Count unavailable" : "Missing · not received"}</span>;
}

function MatchCell({ r }: { r: SerialReconciliationRow }) {
  const p = r.serial_match_pct;
  if (p == null || !Number.isFinite(p)) {
    return (
      <span className="text-muted-foreground" title={r.sell_through_source === "serials" ? "Not comparable: sell-through is itself derived from serials" : "Not comparable"}>
        — <span className="text-[10px]">n/c</span>
      </span>
    );
  }
  const tone = p > 100 ? "text-rose-700 font-semibold" : p < 100 ? "text-amber-700" : "text-emerald-700";
  return <span className={`font-mono ${tone}`}>{p.toFixed(1)}%</span>;
}

function StatusCell({ r }: { r: SerialReconciliationRow }) {
  if (!r.alerts.length) return <span className="text-xs text-muted-foreground">OK</span>;
  return (
    <div className="flex flex-col gap-1">
      {r.alerts.map((a, i) => (
        <span
          key={i}
          className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${
            a.severity === "high" ? "bg-rose-100 text-rose-800 ring-1 ring-rose-300" : "bg-sky-50 text-sky-800 ring-1 ring-sky-200"
          }`}
        >
          {a.severity === "high" ? <ShieldAlert className="h-3 w-3 shrink-0" /> : <Info className="h-3 w-3 shrink-0" />}
          {a.severity === "high" ? "High" : "Low"} · {a.message}
        </span>
      ))}
    </div>
  );
}

export function SerialReconciliation({ week, windowWeeks, onWeekChange, partIds, resellerIds, category, enabled }: Props) {
  const params = { week_iso: week, part_ids: partIds, reseller_ids: resellerIds, category };
  const { data, isLoading, isError, refetch, isFetching } = useGetSerialReconciliation(params, {
    query: {
      queryKey: getGetSerialReconciliationQueryKey(params),
      enabled,
      staleTime: 0,
      refetchOnMount: "always",
      refetchInterval: 30000,
    },
  });

  const rows = useMemo(() => {
    const all = selectReconciliationWeek(data?.rows ?? [], data?.week_iso ?? week);
    const rank = (r: SerialReconciliationRow) => (r.alerts.some(a => a.severity === "high") ? 0 : r.alerts.length ? 1 : 2);
    return all.sort((a, b) => rank(a) - rank(b) || a.code.localeCompare(b.code) || a.part_no.localeCompare(b.part_no));
  }, [data, week]);
  const highCount = rows.filter(r => r.alerts.some(a => a.severity === "high")).length;
  const lowCount = rows.filter(r => r.alerts.some(a => a.severity === "low")).length;
  const weeks = [...(windowWeeks ?? data?.weeks ?? [])].sort((a, b) => b.localeCompare(a));
  const activeWeek = data?.week_iso ?? week;

  return (
    <Card className="shadow-xs" data-testid="card-serial-reconciliation">
      <CardHeader className="px-4 py-3 border-b bg-muted/10 flex flex-row flex-wrap gap-2 items-center justify-between space-y-0">
        <CardTitle className="text-sm font-medium flex flex-wrap items-center gap-2">
          <ScanBarcode className="h-4 w-4 text-violet-600" />
          Serial reconciliation · DD sell-in vs sell-through vs SOH
          {highCount > 0 && <Badge className="bg-rose-600 hover:bg-rose-600 text-white text-[10px]" data-testid="badge-high-count">{highCount} high</Badge>}
          {lowCount > 0 && <Badge variant="outline" className="text-[10px] border-sky-300 text-sky-800" data-testid="badge-low-count">{lowCount} low</Badge>}
          <Tooltip>
            <TooltipTrigger asChild><Info className="h-4 w-4 text-muted-foreground" /></TooltipTrigger>
            <TooltipContent className="max-w-xs text-xs space-y-1">
              <p>Serial match % = serials reported ÷ SOH units sold.</p>
              <p>Dash / n/c means not comparable (no SOH sold figure, or sell-through comes from serials).</p>
              <p>DD sell-in = Pronto net invoiced units minus credits for the week. Dash = outside Pronto coverage.</p>
            </TooltipContent>
          </Tooltip>
        </CardTitle>
        <div className="flex items-center gap-2">
          {isFetching && !isLoading && <span className="text-[10px] text-muted-foreground">Refreshing…</span>}
          <Select value={activeWeek ?? undefined} onValueChange={onWeekChange} disabled={!weeks.length}>
            <SelectTrigger className="h-8 w-[230px] text-xs" data-testid="select-recon-week">
              <SelectValue placeholder="Reporting week" />
            </SelectTrigger>
            <SelectContent>
              {weeks.map(w => (
                <SelectItem key={w} value={w} className="text-xs" data-testid={`option-recon-week-${w}`}>
                  {w} · {formatWeekRange(w)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="px-4 pt-3 space-y-1 text-xs text-muted-foreground">
          <p data-testid="text-recon-week">{formatWeekLabel(activeWeek)} · click a heatmap cell to jump to its week</p>
          {(data?.pronto_note || data?.pronto_through) && (
            <p data-testid="text-pronto-note" className="text-slate-700">
              <span className="font-medium">Pronto DD:</span> {data.pronto_note ?? `Data through ${data.pronto_through}`}
            </p>
          )}
          {data && data.unmatched_serials > 0 && (
            <p data-testid="text-unmatched-serials" className="text-amber-700">
              {num(data.unmatched_serials)} reported serial{data.unmatched_serials === 1 ? "" : "s"} could not be assigned to a SKU/customer and are excluded below.
            </p>
          )}
          <p className="md:hidden">Scroll sideways to see all columns.</p>
        </div>
        {isLoading ? (
          <div className="p-4 space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
        ) : isError ? (
          <div className="p-8 flex flex-col items-center gap-2 text-muted-foreground">
            <AlertCircle className="h-8 w-8" />
            <p>Could not load serial reconciliation.</p>
            <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-retry-recon">Try again</Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="p-8 flex flex-col items-center text-muted-foreground" data-testid="empty-recon">
            <ScanBarcode className="h-8 w-8 mb-2 opacity-40" />
            <p>No SOH, serial or DD rows for this week and selection.</p>
            <p className="text-xs mt-1">Pick another week or adjust filters.</p>
          </div>
        ) : (
          <div className="overflow-x-auto p-4 pt-3">
            <table className="w-full min-w-[920px] text-xs border-collapse" data-testid="table-serial-reconciliation">
              <thead>
                <tr className="border-b text-left text-muted-foreground [&>th]:py-2 [&>th]:px-2 [&>th]:font-semibold">
                  <th>Account</th><th>SKU</th><th>Week</th>
                  <th className="text-right">DD sell-in</th><th className="text-right">Sell-through</th>
                  <th className="text-right">SOH</th><th className="text-right">Serials reported</th>
                  <th className="text-right">Serial match %</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const high = r.alerts.some(a => a.severity === "high");
                  return (
                    <tr key={`${r.reseller_id}-${r.part_no}-${r.week_iso}-${i}`}
                      className={`border-b align-top hover:bg-muted/40 [&>td]:py-1.5 [&>td]:px-2 ${high ? "bg-rose-50/60" : ""}`}
                      data-testid={`row-recon-${r.reseller_id}-${r.part_id ?? r.part_no}`}>
                      <td className="font-medium whitespace-nowrap">{customerLabel(r.code)}</td>
                      <td className="font-mono whitespace-nowrap" title={r.part_id == null ? "Custom source SKU (not in catalogue)" : undefined}>
                        {r.part_no}{r.part_id == null && <span className="ml-1 text-[9px] text-muted-foreground">src</span>}
                      </td>
                      <td className="whitespace-nowrap" title={formatWeekLabel(r.week_iso)}>
                        <span className="font-mono">{r.week_iso}</span>
                        <span className="block text-[10px] text-muted-foreground">{formatWeekRange(r.week_iso)}</span>
                      </td>
                      <td className="text-right font-mono">{r.dd_sell_in_week == null ? dash : num(r.dd_sell_in_week)}</td>
                      <td className="text-right whitespace-nowrap">
                        {r.sell_through_source === "missing" || r.sell_through == null ? (
                          <span className="text-amber-700">Missing</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 justify-end">
                            <span className="font-mono">{num(r.sell_through)}</span>
                            <SourceTag source={r.sell_through_source} />
                          </span>
                        )}
                      </td>
                      <td className="text-right font-mono">
                        {!r.soh_reported ? <span className="font-sans text-amber-700">SOH missing</span> : r.soh == null ? <span title="SKU not in this SOH file">{dash}</span> : num(r.soh)}
                      </td>
                      <td className="text-right"><SerialsCell r={r} /></td>
                      <td className="text-right"><MatchCell r={r} /></td>
                      <td><StatusCell r={r} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
