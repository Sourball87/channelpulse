import { useEffect, useState } from "react";
import { getGetSerialTrailQueryKey, useGetSerialTrail, type ScanbackSerialEvent } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, RefreshCw } from "lucide-react";
import { customerLabel, maskCustomerText } from "@/lib/customer-display";
import { SectionEmpty, errorMessage, formatCents, formatDate } from "./shared";
import { cn } from "@/lib/utils";

export function normalizeSerial(s: string): string {
  return s.trim().replace(/\s+/g, "").toUpperCase();
}

const STATUS_STYLE: Record<string, string> = {
  UNKNOWN: "bg-slate-100 text-slate-700 ring-slate-400/40",
  INVOICED: "bg-cyan-50 text-cyan-800 ring-cyan-600/30",
  SOLD: "bg-amber-50 text-amber-800 ring-amber-600/30",
  CLAIMED: "bg-rose-50 text-rose-800 ring-rose-600/30",
};
const KIND_LABEL: Record<ScanbackSerialEvent["kind"], string> = {
  invoice: "Invoiced", credit: "Credited", sold: "Reported sold", claimed: "Claimed",
};
const KIND_STYLE: Record<ScanbackSerialEvent["kind"], string> = {
  invoice: "border-cyan-500", credit: "border-slate-400", sold: "border-amber-500", claimed: "border-rose-500",
};

export function SerialLookup({ initialSerial, onSearch }: { initialSerial?: string; onSearch: (serial: string) => void }) {
  const [text, setText] = useState(initialSerial ?? "");
  const [serial, setSerial] = useState(() => normalizeSerial(initialSerial ?? ""));
  useEffect(() => {
    const n = normalizeSerial(initialSerial ?? "");
    setText(initialSerial ?? ""); setSerial(n);
  }, [initialSerial]);
  const q = useGetSerialTrail(serial, {
    query: { enabled: !!serial, queryKey: getGetSerialTrailQueryKey(serial), staleTime: 0, refetchInterval: 30000 },
    request: undefined,
  });
  const submit = () => {
    const n = normalizeSerial(text);
    if (!n) return;
    setSerial(n);
    onSearch(n);
    if (n === serial) void q.refetch();
  };
  const trail = q.data;
  const events = trail ? [...trail.events].sort((a, b) => a.date.localeCompare(b.date)) : [];

  return (
    <div className="space-y-4">
      <form className="flex flex-wrap items-end gap-2 rounded-lg border bg-background p-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="min-w-[260px] flex-1 space-y-1">
          <label htmlFor="serial-lookup" className="text-xs font-medium">Serial number (exact match, spaces removed, case-insensitive)</label>
          <Input id="serial-lookup" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. R5CW31ABC2K" className="font-mono" data-testid="input-serial-lookup" autoComplete="off" />
        </div>
        <Button type="submit" disabled={!normalizeSerial(text)} data-testid="button-serial-search"><Search className="mr-1.5 h-4 w-4" /> Search</Button>
        {serial && <Button type="button" variant="outline" onClick={() => q.refetch()} disabled={q.isFetching} data-testid="button-serial-refresh"><RefreshCw className={cn("mr-1.5 h-4 w-4", q.isFetching && "animate-spin")} /> Refresh</Button>}
      </form>

      {!serial ? (
        <SectionEmpty title="Look up a serial" body="Enter a serial and press Search or Enter. You will see every invoice, credit, customer sale report and claim recorded against it, including repeats." />
      ) : q.isLoading ? (
        <div className="space-y-2" data-testid="loading-serial"><Skeleton className="h-12 w-full" /><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div>
      ) : q.isError ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800" data-testid="text-serial-error">
          <p className="font-semibold">Could not load serial {serial}</p><p className="mt-1">{errorMessage(q.error)}</p>
          <Button className="mt-2" size="sm" variant="outline" onClick={() => q.refetch()} data-testid="button-serial-retry">Retry</Button>
        </div>
      ) : trail ? (
        <div className="rounded-lg border bg-background">
          <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
            <span className="font-mono text-lg font-semibold" data-testid="text-serial-value">{trail.serial}</span>
            <span data-testid="status-serial" className={cn("rounded px-2 py-0.5 text-xs font-semibold ring-1 ring-inset", STATUS_STYLE[trail.status])}>{trail.status}</span>
            <span className="text-xs text-slate-500">{events.length} event{events.length === 1 ? "" : "s"} &middot; refreshes every 30s</span>
          </div>
          {trail.status === "UNKNOWN" || events.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-slate-600" data-testid="text-serial-unknown">UNKNOWN: no invoice, customer report or claim contains this exact serial.</p>
          ) : (
            <ol className="divide-y">
              {events.map((e, i) => (
                <li key={i} className={cn("border-l-4 px-4 py-2.5 text-sm", KIND_STYLE[e.kind], e.reused && "bg-rose-50/60")} data-testid={`row-serial-event-${i}`}>
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="w-28 text-xs font-semibold uppercase tracking-wide">{KIND_LABEL[e.kind]}</span>
                    <span className="font-mono text-xs">{formatDate(e.date)}</span>
                    <span className="text-xs">{e.kind === "invoice" || e.kind === "credit" ? "Invoiced to" : e.kind === "sold" ? "Reported by" : "Account"}: <b>{e.accountCode ? customerLabel(e.accountCode) : "-"}</b></span>
                    <span className="font-mono text-xs text-slate-500">{e.sku}</span>
                    {e.reused && <span className="rounded bg-rose-600 px-1.5 py-0.5 text-[10px] font-bold uppercase text-white" data-testid={`flag-serial-reused-${i}`}>Repeat / reused</span>}
                  </div>
                  <dl className="mt-1 flex flex-wrap gap-x-5 gap-y-0.5 pl-0 text-xs text-slate-600 sm:pl-[7.75rem]">
                    {e.invoice && <div>Invoice # <span className="font-mono text-slate-900">{e.invoice}</span></div>}
                    {e.unitPriceCents != null && <div>Invoiced ex GST <span className="font-mono text-slate-900">{formatCents(e.unitPriceCents)}</span></div>}
                    {e.costCents != null && <div>Our cost (reference only) <span className="font-mono">{formatCents(e.costCents)}</span></div>}
                    {e.promotion && <div>Promotion <span className="text-slate-900">{maskCustomerText(e.promotion)}</span></div>}
                    {(e.batchReference || e.batchId) && <div>Batch <span className="font-mono text-slate-900">{e.batchReference || "-"}</span>{e.batchId && <span className="font-mono text-slate-400"> ({e.batchId})</span>}</div>}
                    {e.amountCents != null && <div>Claim amount <span className="font-mono font-semibold text-slate-900">{formatCents(e.amountCents)}</span></div>}
                    <div>Source <span className="text-slate-900">{maskCustomerText(e.sourceName)}</span>{e.sourceRow != null && <span className="font-mono"> row {e.sourceRow}</span>}</div>
                  </dl>
                  {e.reason && <p className={cn("mt-1 text-xs sm:pl-[7.75rem]", e.reused ? "text-rose-800" : "text-slate-500")}>{maskCustomerText(e.reason)}</p>}
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </div>
  );
}
