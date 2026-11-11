import { Fragment, useEffect, useMemo, useState } from "react";
import { useGetScanbackClaimsByWeek, getGetScanbackClaimsByWeekQueryKey, getExportScanbackClaimsByWeekUrl, type ScanbackProgram } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { customerLabel } from "@/lib/customer-display";
import { ChevronDown, ChevronRight, Download, RotateCw } from "lucide-react";
import { errorMessage, formatCents, formatDate } from "./shared";
import { TRACKING_ROW, TrackingTag, type TrackingColor } from "./tracking";

const STATUS_LABEL = {
  approved: "Approved",
  awaiting_approval: "Qualifies – awaiting approval",
  not_qualifying: "Not qualifying",
} as const;

function sydneyToday() {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function ClaimsByWeekPanel({ programs }: { programs: ScanbackProgram[] }) {
  const [, navigate] = useLocation();
  const activePrograms = useMemo(() => [...programs].filter((p) => !p.archived).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [programs]);
  const today = sydneyToday();
  const liveProgram = activePrograms.find((p) => p.start.slice(0, 10) <= today && p.end.slice(0, 10) >= today);
  const [programId, setProgramId] = useState(() => liveProgram?.id ?? activePrograms[0]?.id ?? programs[0]?.id ?? "");
  const [week, setWeek] = useState("");
  const [customerId, setCustomerId] = useState("all");
  const [status, setStatus] = useState<"all" | "approved" | "awaiting_approval" | "not_qualifying">("all");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!programs.some((p) => p.id === programId)) setProgramId(liveProgram?.id ?? activePrograms[0]?.id ?? programs[0]?.id ?? "");
  }, [programs, activePrograms, liveProgram, programId]);
  useEffect(() => { setWeek(""); setCustomerId("all"); setExpanded(new Set()); }, [programId]);

  const params = useMemo(() => ({
    programId,
    ...(week ? { week } : {}),
    ...(customerId !== "all" ? { customerId: Number(customerId) } : {}),
    status,
  }), [programId, week, customerId, status]);
  const query = useGetScanbackClaimsByWeek(params, {
    query: { queryKey: getGetScanbackClaimsByWeekQueryKey(params), enabled: !!programId },
  });
  const report = query.data;
  useEffect(() => {
    if (report?.programId === programId && !week) setWeek(report.selectedWeek ?? report.defaultWeek);
  }, [report, week, programId]);

  const exportUrl = report ? getExportScanbackClaimsByWeekUrl(params) : "#";
  const toggleCustomer = (id: number) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <section className="space-y-4" data-testid="section-claims-by-week">
      <div className="rounded-lg border bg-background">
        <div className="grid gap-3 border-b p-4 sm:grid-cols-2 xl:grid-cols-[minmax(220px,1.4fr)_minmax(220px,1.2fr)_minmax(180px,1fr)_minmax(180px,1fr)_auto] xl:items-end">
          <div className="space-y-1">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-500" htmlFor="claims-program">Promotion</label>
            <Select value={programId} onValueChange={setProgramId}>
              <SelectTrigger id="claims-program" data-testid="select-claims-program"><SelectValue placeholder="Choose promotion" /></SelectTrigger>
              <SelectContent>{programs.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}{p.archived ? " (archived)" : ""}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-500" htmlFor="claims-week">Customer sold date · Monday–Sunday</label>
            <Select value={week || report?.selectedWeek || report?.defaultWeek || ""} onValueChange={setWeek}>
              <SelectTrigger id="claims-week" data-testid="select-claims-week"><SelectValue placeholder="Choose week" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All weeks in promotion</SelectItem>
                {(report?.weekOptions ?? []).map((item) => <SelectItem key={item.weekIso} value={item.weekIso}>{item.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-500" htmlFor="claims-customer">Customer</label>
            <Select value={customerId} onValueChange={setCustomerId}>
              <SelectTrigger id="claims-customer" data-testid="select-claims-customer"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All customers</SelectItem>{report?.customers.map((c) => <SelectItem key={c.accountId} value={String(c.accountId)}>{customerLabel(c.accountCode)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-500" htmlFor="claims-status">Status</label>
            <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
              <SelectTrigger id="claims-status" data-testid="select-claims-status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="awaiting_approval">Awaiting approval</SelectItem>
                <SelectItem value="not_qualifying">Not qualifying</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" size="sm" className="h-9" disabled={!report} asChild data-testid="link-export-claims-week">
            <a href={exportUrl} download><Download className="mr-1.5 h-4 w-4" /> Export XLSX</a>
          </Button>
        </div>
        {report && (
          <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-50/70 px-4 py-2 text-xs" data-testid="text-claims-week-context">
            <span className="font-medium text-slate-700">{report.programName} <span className="mx-1 text-slate-400">/</span> {week === "all" ? "All weeks in promotion" : report.weekLabel}</span>
            <span className="font-mono text-slate-500">{formatDate(report.programStart)} – {formatDate(report.programEnd)}</span>
          </div>
        )}
      </div>

      {query.isLoading && <div className="space-y-2 rounded-lg border bg-background p-4" aria-label="Loading claims" data-testid="loading-claims-week">
        <div className="h-4 w-56 animate-pulse rounded bg-slate-200" /><div className="h-10 animate-pulse rounded bg-slate-100" /><div className="h-10 animate-pulse rounded bg-slate-100" />
      </div>}
      {query.isError && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800" data-testid="error-claims-week">
        <div><p className="font-semibold">Claims summary could not be loaded</p><p className="mt-0.5">{errorMessage(query.error)}</p></div>
        <Button size="sm" variant="outline" onClick={() => query.refetch()} data-testid="button-retry-claims-week"><RotateCw className="mr-1.5 h-3.5 w-3.5" /> Retry</Button>
      </div>}
      {!query.isLoading && !query.isError && report && (
        <div className="overflow-hidden rounded-lg border bg-background">
          {report.customers.length === 0 ? (
            <div className="px-6 py-12 text-center" data-testid="empty-claims-week">
              <p className="text-sm font-semibold text-slate-700">No claims for this selection</p>
              <p className="mt-1 text-sm text-slate-500">Try another week or status, or review the promotion’s serial reports.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table className="min-w-[1120px]">
                <TableHeader><TableRow className="bg-slate-50/70">
                  <TableHead className="w-9" /><TableHead>Customer</TableHead><TableHead className="text-right">Serials reported</TableHead><TableHead className="text-right">Qualifying</TableHead><TableHead className="text-right">Not qualifying</TableHead><TableHead className="text-right">Qualifying claim</TableHead><TableHead className="text-right">Approved</TableHead><TableHead className="text-right">Awaiting approval</TableHead><TableHead className="w-32 text-right">Review</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {report.customers.map((customer) => {
                    const isOpen = expanded.has(customer.accountId);
                    return <Fragment key={customer.accountId}>
                      <TableRow data-testid={`row-claims-customer-${customer.accountId}`} className="group">
                        <TableCell className="px-2"><button type="button" aria-label={`${isOpen ? "Collapse" : "Expand"} ${customerLabel(customer.accountCode)}`} aria-expanded={isOpen} onClick={() => toggleCustomer(customer.accountId)} data-testid={`button-expand-claims-${customer.accountId}`} className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900">{isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</button></TableCell>
                        <TableCell className="font-medium" data-testid={`text-claims-customer-${customer.accountId}`}>{customerLabel(customer.accountCode)}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{customer.hasSerialReport ? customer.reportedCount : <span className="font-sans text-xs text-slate-500">No serial report</span>}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{customer.qualifyingCount}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{customer.notQualifyingCount}</TableCell>
                        <TableCell className="text-right font-mono font-semibold tabular-nums">{formatCents(customer.qualifyingCents)}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{formatCents(customer.approvedCents)}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{formatCents(customer.awaitingApprovalCents)}</TableCell>
                        <TableCell className="text-right">{customer.awaitingApprovalCents > 0 && <Button size="sm" className="h-7 px-2.5 text-xs" data-testid={`button-review-claims-${customer.accountId}`} onClick={() => navigate(`/scanback?tab=verify&promotion=${encodeURIComponent(report.programId)}&reseller=${customer.accountId}`)}>Review in Verify</Button>}</TableCell>
                      </TableRow>
                      {isOpen && <TableRow data-testid={`row-claims-details-${customer.accountId}`} className="hover:bg-transparent">
                        <TableCell colSpan={9} className="bg-slate-50/60 p-0">
                          {customer.lines.length === 0 ? <p className="px-8 py-5 text-sm text-slate-500">{customer.hasSerialReport ? "No serial details for this selection." : "No serial report"}</p> : (
                            <div className="overflow-x-auto">
                              <Table className="min-w-[1260px]">
                                <TableHeader><TableRow className="border-t-0 bg-slate-100/80">
                                  <TableHead>Serial</TableHead><TableHead>SKU</TableHead><TableHead>Sold date</TableHead><TableHead>DD invoice</TableHead><TableHead className="text-right">Invoiced price ex GST</TableHead><TableHead className="text-right">GTM Buy Ex</TableHead><TableHead className="text-right">Claim amount</TableHead><TableHead>Status / reason</TableHead>
                                </TableRow></TableHeader>
                                <TableBody>{customer.lines.map((line, index) => {
                                  const color = line.trackingColor as TrackingColor;
                                  return <TableRow key={`${line.serial}-${index}`} data-testid={`row-claim-serial-${customer.accountId}-${index}`} data-tracking={color} className={TRACKING_ROW[color]}>
                                    <TableCell className="font-mono text-xs font-medium">{line.serial}</TableCell>
                                    <TableCell className="font-mono text-xs">{line.sku}</TableCell>
                                    <TableCell className="text-xs">{formatDate(line.soldDate)}</TableCell>
                                    <TableCell className="text-xs"><span className="font-mono">{line.invoiceNo || "—"}</span><span className="block text-slate-500">{formatDate(line.invoiceDate)}</span></TableCell>
                                    <TableCell className="text-right font-mono text-xs">{formatCents(line.invoicedPriceCents)}</TableCell>
                                    <TableCell className="text-right font-mono text-xs">{formatCents(line.gtmBuyExCents)}</TableCell>
                                    <TableCell className="text-right font-mono text-xs font-semibold">{formatCents(line.claimCents)}</TableCell>
                                    <TableCell className="max-w-sm text-xs">
                                      <div className="flex flex-wrap items-center gap-1.5">
                                        <span className={`inline-flex whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${line.status === "approved" ? "bg-emerald-50 text-emerald-800 ring-emerald-600/25" : line.status === "awaiting_approval" ? "bg-amber-50 text-amber-800 ring-amber-600/30" : "bg-rose-50 text-rose-800 ring-rose-600/25"}`}>
                                          {STATUS_LABEL[line.status]}{line.status === "approved" && line.batchReference ? ` [${line.batchReference}]` : ""}
                                        </span>
                                        <TrackingTag color={color} />
                                      </div>
                                      {line.status === "not_qualifying" && <p className="mt-1 text-slate-600">{line.reason}</p>}
                                    </TableCell>
                                  </TableRow>;
                                })}</TableBody>
                              </Table>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>}
                    </Fragment>;
                  })}
                  <TableRow className="border-t-2 bg-slate-50 font-semibold" data-testid="row-claims-week-total">
                    <TableCell /><TableCell>Total</TableCell><TableCell className="text-right font-mono tabular-nums">{report.totals.reportedCount}</TableCell><TableCell className="text-right font-mono tabular-nums">{report.totals.qualifyingCount}</TableCell><TableCell className="text-right font-mono tabular-nums">{report.totals.notQualifyingCount}</TableCell><TableCell className="text-right font-mono tabular-nums">{formatCents(report.totals.qualifyingCents)}</TableCell><TableCell className="text-right font-mono tabular-nums">{formatCents(report.totals.approvedCents)}</TableCell><TableCell className="text-right font-mono tabular-nums">{formatCents(report.totals.awaitingApprovalCents)}</TableCell><TableCell />
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

