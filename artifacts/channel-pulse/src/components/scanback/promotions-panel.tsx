import { Fragment, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getExportScanbackPromotionUrl,
  getGetScanbackPromotionQueryKey,
  getGetScanbackWorkspaceQueryKey,
  useCloseScanbackPartner,
  useGetScanbackPromotion,
  useReconcileScanbackPartner,
  type ScanbackBatch,
  type ScanbackProgram,
  type ScanbackPromotionPartner,
  type ScanbackPromotionTally,
} from "@workspace/api-client-react";
import { ChevronDown, ChevronRight, Download, FileCheck2, Lock, RefreshCw, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { customerLabel, maskCustomerText } from "@/lib/customer-display";
import { errorMessage, formatCents, formatDate, formatDateTime, SectionEmpty } from "./shared";
import { TRACKING_ROW, TrackingTag, trackingColorOf } from "./tracking";

type Phase = "scheduled" | "live" | "ended";

function todayIso() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}
function phaseOf(p: ScanbackProgram, today: string): Phase {
  if (p.start > today) return "scheduled";
  if (p.end < today) return "ended";
  return "live";
}
/** live first, then most recently ended by end date, then upcoming (soonest start). */
function orderPrograms(programs: ScanbackProgram[]) {
  const today = todayIso();
  const rank = { live: 0, ended: 1, scheduled: 2 } as const;
  return programs.slice().sort((a, b) => {
    if (!!a.archived !== !!b.archived) return a.archived ? 1 : -1;
    const pa = phaseOf(a, today), pb = phaseOf(b, today);
    if (pa !== pb) return rank[pa] - rank[pb];
    if (pa === "ended") return b.end.localeCompare(a.end);
    if (pa === "scheduled") return a.start.localeCompare(b.start);
    return a.end.localeCompare(b.end);
  });
}
const batchUrl = (id: string) => `/api/scanback/batches/${encodeURIComponent(id)}/export/xlsx`;

type Review = {
  accountId: number;
  snapshot: ScanbackPromotionPartner;
  exclusions: Record<string, string>;
  checked: Record<string, string>; // exclusions as sent with the snapshot
  earlyNote: string;
  reference: string;
  batch: ScanbackBatch | null;
};

export function PromotionsPanel({ programs, initialProgramId, onOpenSerial }: {
  programs: ScanbackProgram[]; initialProgramId?: string; onOpenSerial: (serial: string) => void;
}) {
  const ordered = useMemo(() => orderPrograms(programs), [programs]);
  const [programId, setProgramId] = useState<string>(() =>
    (initialProgramId && programs.some((p) => p.id === initialProgramId) ? initialProgramId : ordered[0]?.id) ?? "");
  useEffect(() => {
    if (initialProgramId) setProgramId(initialProgramId);
  }, [initialProgramId]);
  useEffect(() => {
    if (!programs.some((p) => p.id === programId)) setProgramId(ordered[0]?.id ?? "");
  }, [programId, ordered, programs]);

  const tallyQ = useGetScanbackPromotion(programId, {
    query: { enabled: !!programId, queryKey: getGetScanbackPromotionQueryKey(programId), refetchInterval: 30000, refetchOnWindowFocus: true },
  });

  if (!ordered.length) return <SectionEmpty title="No promotions yet" body="Create or upload a program table in Programs. Its running tally appears here as weekly serial reports are committed." />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={programId} onValueChange={setProgramId}>
          <SelectTrigger className="h-9 w-[380px] max-w-full bg-background" data-testid="select-promotion"><SelectValue placeholder="Choose promotion" /></SelectTrigger>
          <SelectContent>
            {ordered.map((p) => {
              const ph = phaseOf(p, todayIso());
              return (
                <SelectItem key={p.id} value={p.id} data-testid={`option-promotion-${p.id}`}>
                  <span className="mr-2">{p.name}{p.archived ? " (archived)" : ""}</span>
                  <span className="text-[11px] text-muted-foreground">{ph === "live" ? "Live" : ph === "ended" ? "Ended" : "Upcoming"} · {formatDate(p.start)} – {formatDate(p.end)}</span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        {tallyQ.isFetching && !tallyQ.isLoading && <span className="text-[11px] text-muted-foreground">Refreshing tally…</span>}
      </div>
      {tallyQ.isLoading ? (
        <div className="space-y-2"><Skeleton className="h-20 w-full" /><Skeleton className="h-64 w-full" /></div>
      ) : tallyQ.isError || !tallyQ.data ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-5 text-sm text-rose-800">
          <p className="font-semibold">Could not load promotion tally</p>
          <p className="mt-1">{errorMessage(tallyQ.error)}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => tallyQ.refetch()} data-testid="button-retry-promotion">Retry</Button>
        </div>
      ) : (
        <PromotionView key={programId} tally={tallyQ.data} onOpenSerial={onOpenSerial} />
      )}
    </div>
  );
}

function StatusBanner({ tally }: { tally: ScanbackPromotionTally }) {
  const { status, program, daysLeft } = tally;
  const tone = status === "live" ? "border-sky-200 bg-sky-50 text-sky-900"
    : status === "ended" ? "border-amber-200 bg-amber-50 text-amber-900"
    : status === "reconciled" ? "border-emerald-200 bg-emerald-50 text-emerald-900"
    : "border-slate-200 bg-slate-50 text-slate-700";
  const label = program.archived ? "Archived — read-only"
    : status === "live" ? `Live — ${daysLeft} day${daysLeft === 1 ? "" : "s"} left`
    : status === "ended" ? "Ended — ready to reconcile"
    : status === "reconciled" ? "Reconciled" : "Scheduled — not started";
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3", tone)}>
      <div>
        <p className="text-base font-semibold" data-testid="text-promotion-status">{label}</p>
        <p className="text-xs opacity-80">{program.name} · {formatDate(program.start)} – {formatDate(program.end)} · as at {formatDate(tally.today)}</p>
      </div>
      {status === "live" && <p className="text-xs font-medium">Running tally — not final. Read-only until the end date.</p>}
    </div>
  );
}

function PromotionView({ tally, onOpenSerial }: { tally: ScanbackPromotionTally; onOpenSerial: (s: string) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const reconcile = useReconcileScanbackPartner();
  const close = useCloseScanbackPartner();
  const id = tally.program.id;
  const live = tally.status === "live";
  const scheduled = tally.status === "scheduled";
  const [expanded, setExpanded] = useState<number | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [earlyFor, setEarlyFor] = useState<number | null>(null);
  const [earlyDraft, setEarlyDraft] = useState("");
  const [queue, setQueue] = useState<number[] | null>(null);

  const invalidate = (serials: string[] = []) => Promise.all([
    qc.invalidateQueries({ queryKey: getGetScanbackPromotionQueryKey(id) }),
    qc.invalidateQueries({ queryKey: getGetScanbackWorkspaceQueryKey() }),
    qc.invalidateQueries({ queryKey: ["/api/upload-center"] }),
    ...serials.map((s) => qc.invalidateQueries({ queryKey: [`/api/scanback/serials/${s}`] })),
  ]);

  const startReview = async (accountId: number, earlyNote?: string) => {
    try {
      const snap = await reconcile.mutateAsync({ id, accountId, data: earlyNote ? { earlyNote } : {} });
      setReview({ accountId, snapshot: snap, exclusions: {}, checked: {}, earlyNote: earlyNote ?? "", reference: "", batch: null });
      setExpanded(accountId);
      setEarlyFor(null); setEarlyDraft("");
    } catch (e) { toast({ title: "Reconcile failed", description: errorMessage(e), variant: "destructive" }); }
  };
  const recheck = async () => {
    if (!review) return;
    const exclusions = Object.entries(review.exclusions).map(([lineId, note]) => ({ lineId, note: note.trim() }));
    if (exclusions.some((x) => !x.note)) { toast({ title: "Each exclusion needs a note", variant: "destructive" }); return; }
    try {
      const snap = await reconcile.mutateAsync({ id, accountId: review.accountId, data: { ...(review.earlyNote ? { earlyNote: review.earlyNote } : {}), exclusions } });
      setReview({ ...review, snapshot: snap, checked: { ...review.exclusions } });
    } catch (e) { toast({ title: "Recheck failed", description: errorMessage(e), variant: "destructive" }); }
  };
  const approve = async () => {
    if (!review?.snapshot.token) return;
    try {
      const batch = await close.mutateAsync({ id, accountId: review.accountId, data: { token: review.snapshot.token, reference: review.reference.trim() } });
      setReview({ ...review, batch });
      toast({ title: "Partner closed", description: `${batch.reference} · ${formatCents(batch.totalCents)}` });
      await invalidate(batch.rows.map((r) => r.serial));
    } catch (e) { toast({ title: "Approve failed", description: errorMessage(e) + " — recheck and try again.", variant: "destructive" }); }
  };

  const openPartners = tally.partners.filter((p) => !p.closed).map((p) => p.accountId);
  const startAll = () => { if (!openPartners.length) return; setQueue(openPartners); void startReview(openPartners[0]); };
  const advance = () => {
    if (!queue || !review) { setReview(null); return; }
    const rest = queue.filter((a) => a !== review.accountId);
    setQueue(rest.length ? rest : null);
    if (rest.length) void startReview(rest[0]); else setReview(null);
  };
  const exitAll = () => { setQueue(null); setReview(null); };

  const exportAll = getExportScanbackPromotionUrl(id);

  return (
    <div className="space-y-4">
      <StatusBanner tally={tally} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" asChild data-testid="link-export-promotion">
            <a href={exportAll} download><Download className="mr-1.5 h-4 w-4" /> Export promotion XLSX{live && " (running tally — not final)"}</a>
          </Button>
        </div>
        {tally.status === "ended" && !tally.program.archived && (
          queue ? (
            <div className="flex items-center gap-2 text-xs text-slate-600" data-testid="text-walkthrough">
              Reconcile all: {tally.partners.length - openPartners.length} closed, {queue.length} remaining
              <Button size="sm" variant="ghost" onClick={exitAll} data-testid="button-exit-walkthrough"><X className="mr-1 h-3.5 w-3.5" /> Exit</Button>
            </div>
          ) : (
            <Button size="sm" disabled={!openPartners.length || reconcile.isPending} onClick={startAll} data-testid="button-reconcile-all">
              <FileCheck2 className="mr-1.5 h-4 w-4" /> Reconcile all ({openPartners.length})
            </Button>
          )
        )}
      </div>

      {!tally.partners.length ? (
        <SectionEmpty title="No partners in this promotion" body="Add customers to the program in Programs to start the tally." />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm" data-testid="table-promotion-tally">
            <thead className="bg-muted/60 text-[11px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">Partner</th><th className="px-3 py-2 text-left">Weeks reported</th>
                <th className="px-3 py-2 text-right">Serials reported</th><th className="px-3 py-2 text-right">Qualifying</th>
                <th className="px-3 py-2 text-right">Not qualifying</th><th className="px-3 py-2 text-right">Claim $ to date</th>
                <th className="px-3 py-2 text-right">Cap used</th><th className="px-3 py-2 text-left">Status</th><th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {tally.partners.map((p) => {
                const open = expanded === p.accountId;
                const inReview = review?.accountId === p.accountId;
                return (
                  <Fragment key={p.accountId}>
                    <tr className={cn("cursor-pointer border-t hover:bg-muted/40", open && "bg-muted/30")} onClick={() => setExpanded(open ? null : p.accountId)} data-testid={`row-partner-${p.accountId}`}>
                      <td className="px-3 py-2 font-medium">
                        <span className="inline-flex items-center gap-1">{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}{customerLabel(p.accountCode)}</span>
                      </td>
                      <td className="px-3 py-2">
                        <span className="font-mono">{p.weeksReported} of {p.weeksExpected}</span>
                        {p.missingWeeks.length > 0 && <span className="ml-2 text-[11px] text-rose-700">missing {p.missingWeeks.map(formatDate).join(", ")}</span>}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{p.reported}</td>
                      <td className="px-3 py-2 text-right font-mono">{p.qualifying}</td>
                      <td className="px-3 py-2 text-right font-mono">{p.notQualifying}</td>
                      <td className="px-3 py-2 text-right font-mono font-semibold">{formatCents(p.claimCents)}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{p.capUsed}</td>
                      <td className="px-3 py-2"><PartnerStatus p={p} status={tally.status} /></td>
                      <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                        {!p.closed && !inReview && tally.status === "ended" && !tally.program.archived && !queue && (
                          <Button size="sm" className="h-7 text-xs" disabled={reconcile.isPending} onClick={() => startReview(p.accountId)} data-testid={`button-reconcile-${p.accountId}`}>Reconcile</Button>
                        )}
                        {!p.closed && !inReview && live && !tally.program.archived && (
                          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { setEarlyFor(p.accountId); setExpanded(p.accountId); }} data-testid={`button-reconcile-early-${p.accountId}`}>
                            <ShieldAlert className="mr-1 h-3.5 w-3.5" /> Reconcile early
                          </Button>
                        )}
                        {!p.closed && scheduled && <Button size="sm" className="h-7 text-xs" disabled title="Reconcile opens after the end date">Reconcile</Button>}
                      </td>
                    </tr>
                    {open && (
                      <tr className="border-t bg-slate-50/50">
                        <td colSpan={9} className="px-4 py-4">
                          {earlyFor === p.accountId && !inReview && (
                            <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3">
                              <p className="text-sm font-semibold text-amber-900">Early reconcile override for {customerLabel(p.accountCode)}</p>
                              <p className="text-xs text-amber-800">The promotion is still live. Explain why this partner is being closed before the end date.</p>
                              <Textarea className="mt-2 bg-background" value={earlyDraft} onChange={(e) => setEarlyDraft(e.target.value)} maxLength={2000} placeholder="Reason (required)" data-testid="input-early-note" />
                              <div className="mt-2 flex gap-2">
                                <Button size="sm" disabled={!earlyDraft.trim() || reconcile.isPending} onClick={() => startReview(p.accountId, earlyDraft.trim())} data-testid="button-confirm-early">Run early reconcile</Button>
                                <Button size="sm" variant="ghost" onClick={() => { setEarlyFor(null); setEarlyDraft(""); }}>Cancel</Button>
                              </div>
                            </div>
                          )}
                          {inReview && review ? (
                            <ReviewPane review={review} setReview={setReview} onRecheck={recheck} onApprove={approve} onNext={advance} walkthrough={!!queue}
                              busy={reconcile.isPending || close.isPending} onOpenSerial={onOpenSerial} onCancel={() => (queue ? exitAll() : setReview(null))} />
                          ) : (
                            <PartnerDetail p={p} programId={id} live={live} onOpenSerial={onOpenSerial} />
                          )}
                          <PriorBatches batches={p.batches} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot className="border-t-2 bg-muted/50 font-semibold">
              <tr data-testid="row-promotion-total">
                <td className="px-3 py-2">Total</td><td />
                <td className="px-3 py-2 text-right font-mono">{tally.totals.reported}</td>
                <td className="px-3 py-2 text-right font-mono">{tally.totals.qualifying}</td>
                <td className="px-3 py-2 text-right font-mono">{tally.totals.notQualifying}</td>
                <td className="px-3 py-2 text-right font-mono">{formatCents(tally.totals.claimCents)}</td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

function PartnerStatus({ p, status }: { p: ScanbackPromotionPartner; status: ScanbackPromotionTally["status"] }) {
  if (p.closed) return <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-800 ring-1 ring-emerald-600/25"><Lock className="h-3 w-3" /> Closed</span>;
  if (p.missingWeeks.length) return <span className="rounded bg-rose-50 px-1.5 py-0.5 text-[11px] font-medium text-rose-800 ring-1 ring-rose-600/25">Missing weeks</span>;
  if (status === "live") return <span className="rounded bg-sky-50 px-1.5 py-0.5 text-[11px] font-medium text-sky-800 ring-1 ring-sky-600/25">Running</span>;
  if (status === "scheduled") return <span className="text-[11px] text-slate-500">Not started</span>;
  return <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-amber-600/30">Ready to reconcile</span>;
}

function WeeksTable({ p }: { p: ScanbackPromotionPartner }) {
  const t = p.weeks.reduce((s, w) => ({ r: s.r + w.reported, q: s.q + w.qualifying, n: s.n + w.notQualifying, c: s.c + w.claimCents }), { r: 0, q: 0, n: 0, c: 0 });
  return (
    <table className="w-full max-w-2xl text-xs" data-testid={`table-weeks-${p.accountId}`}>
      <thead className="text-[10px] uppercase tracking-wider text-slate-500"><tr>
        <th className="py-1 text-left">Week ending</th><th className="text-right">Serials</th><th className="text-right">Qualifying</th><th className="text-right">Not qual.</th><th className="text-right">Claim $</th>
      </tr></thead>
      <tbody>
        {p.weeks.map((w) => (
          <tr key={w.weekIso} className={cn("border-t", w.missing && "bg-rose-50 text-rose-800")}>
            <td className="py-1">{formatDate(w.weekEnd)} <span className="text-slate-400">{w.weekIso}</span>{w.missing && <span className="ml-2 font-medium">No report</span>}</td>
            <td className="text-right font-mono">{w.reported}</td><td className="text-right font-mono">{w.qualifying}</td>
            <td className="text-right font-mono">{w.notQualifying}</td><td className="text-right font-mono">{formatCents(w.claimCents)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot className="border-t-2 font-semibold"><tr>
        <td className="py-1">Total</td><td className="text-right font-mono">{t.r}</td><td className="text-right font-mono">{t.q}</td><td className="text-right font-mono">{t.n}</td><td className="text-right font-mono">{formatCents(t.c)}</td>
      </tr></tfoot>
    </table>
  );
}

function LinesTable({ p, onOpenSerial, exclusions, onToggle, onNote }: {
  p: ScanbackPromotionPartner; onOpenSerial: (s: string) => void;
  exclusions?: Record<string, string>; onToggle?: (lineId: string) => void; onNote?: (lineId: string, note: string) => void;
}) {
  if (!p.lines.length) return <p className="text-xs text-muted-foreground">No serials reported yet.</p>;
  return (
    <div className="max-h-[420px] overflow-auto rounded border bg-background">
      <table className="w-full text-xs" data-testid={`table-lines-${p.accountId}`}>
        <thead className="sticky top-0 bg-muted text-[10px] uppercase tracking-wider text-slate-500"><tr>
          {exclusions && <th className="px-2 py-1.5 text-left">Exclude</th>}
          <th className="px-2 py-1.5 text-left">Serial</th><th className="px-2 text-left">SKU</th><th className="px-2 text-left">Sold</th><th className="px-2 text-left">DD invoice</th>
          <th className="px-2 text-right">Invoiced</th><th className="px-2 text-right">GTM Buy Ex</th><th className="px-2 text-right">Claim $</th><th className="px-2 text-left">Status</th>
        </tr></thead>
        <tbody>
          {p.lines.map((l) => {
            const ex = exclusions && l.lineId in exclusions;
            return (
              <tr key={l.lineId} className={cn("border-t align-top", TRACKING_ROW[trackingColorOf(l)], ex && "opacity-60")}>
                {exclusions && (
                  <td className="px-2 py-1.5">
                    <input type="checkbox" checked={!!ex} disabled={(!l.include && !ex) || l.reason.startsWith("Previously approved")}
                      aria-label={`Exclude ${l.serial}`} onChange={() => onToggle?.(l.lineId)} data-testid={`checkbox-exclude-${l.lineId}`} />
                    {ex && <Input className="mt-1 h-7 w-44 text-xs" value={exclusions[l.lineId]} placeholder="Note (required)" maxLength={2000} onChange={(e) => onNote?.(l.lineId, e.target.value)} data-testid={`input-exclude-note-${l.lineId}`} />}
                  </td>
                )}
                <td className="px-2 py-1.5"><button type="button" className="font-mono text-sky-800 hover:underline" onClick={() => onOpenSerial(l.serial)} data-testid={`link-serial-${l.lineId}`}>{l.serial}</button></td>
                <td className="px-2 font-mono">{l.sku}</td><td className="px-2">{formatDate(l.date)}</td><td className="px-2 font-mono">{l.invoice || "-"}</td>
                <td className="px-2 text-right font-mono">{formatCents(l.unitPriceCents)}</td><td className="px-2 text-right font-mono">{formatCents(l.gtmBuyCents)}</td>
                <td className="px-2 text-right font-mono font-semibold">{l.include ? formatCents(l.amountCents) : "-"}</td>
                <td className="px-2 py-1.5"><TrackingTag color={trackingColorOf(l)} /><p className="mt-0.5 text-[11px] text-slate-600">{maskCustomerText(l.reason)}</p></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PartnerDetail({ p, programId, live, onOpenSerial }: { p: ScanbackPromotionPartner; programId: string; live: boolean; onOpenSerial: (s: string) => void }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <WeeksTable p={p} />
        <Button size="sm" variant="outline" asChild data-testid={`link-export-partner-${p.accountId}`}>
          <a href={getExportScanbackPromotionUrl(programId, { accountId: p.accountId })} download><Download className="mr-1.5 h-4 w-4" /> Export {customerLabel(p.accountCode)} XLSX{live && " (running tally — not final)"}</a>
        </Button>
      </div>
      <LinesTable p={p} onOpenSerial={onOpenSerial} />
    </div>
  );
}

function ReviewPane({ review, setReview, onRecheck, onApprove, onNext, onCancel, walkthrough, busy, onOpenSerial }: {
  review: Review; setReview: (r: Review) => void; onRecheck: () => void; onApprove: () => void; onNext: () => void; onCancel: () => void;
  walkthrough: boolean; busy: boolean; onOpenSerial: (s: string) => void;
}) {
  const s = review.snapshot;
  const amountToApprove = s.lines.filter((line) => line.include && line.status === "eligible" && !line.reason.startsWith("Previously approved"))
    .reduce((sum, line) => sum + line.amountCents, 0);
  const stale = JSON.stringify(review.exclusions) !== JSON.stringify(review.checked);
  const notesMissing = Object.values(review.exclusions).some((n) => !n.trim());
  const toggle = (lineId: string) => {
    const next = { ...review.exclusions };
    if (lineId in next) delete next[lineId]; else next[lineId] = "";
    setReview({ ...review, exclusions: next });
  };
  if (review.batch) {
    return (
      <div className="rounded-md border border-emerald-300 bg-emerald-50 p-4" data-testid="panel-closed">
        <p className="font-semibold text-emerald-900">Approved & closed — {review.batch.reference}</p>
        <p className="text-sm text-emerald-800">{review.batch.approvedCount} serials · {formatCents(review.batch.totalCents)}</p>
        <div className="mt-3 flex gap-2">
          <Button size="sm" asChild data-testid="link-statement"><a href={batchUrl(review.batch.id)} download><Download className="mr-1.5 h-4 w-4" /> Download statement</a></Button>
          <Button size="sm" variant="outline" onClick={onNext} data-testid="button-next-partner">{walkthrough ? "Next partner" : "Done"}</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-4 rounded-md border-2 border-sky-300 bg-background p-4" data-testid="panel-review">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Final check — {customerLabel(s.accountCode)}</p>
          <p className="text-xs text-muted-foreground">Snapshot from latest Dicker evidence. Background refreshes do not change this snapshot.</p>
          {review.earlyNote && <p className="mt-1 text-xs text-amber-800">Early override: {review.earlyNote}</p>}
          {s.missingWeeks.length > 0 && <p className="mt-1 text-xs font-medium text-rose-700">Missing weeks: {s.missingWeeks.map(formatDate).join(", ")}</p>}
          {s.claimCents !== amountToApprove && <p className="mt-1 text-xs text-muted-foreground">Promotion total including prior approvals: {formatCents(s.claimCents)}. Previously approved serials will not be paid again.</p>}
        </div>
        <dl className="flex gap-5 text-right">
          <div><dt className="text-[10px] uppercase text-slate-500">Qualifying</dt><dd className="font-mono text-lg font-semibold">{s.qualifying}</dd></div>
          <div><dt className="text-[10px] uppercase text-slate-500">Final amount to approve</dt><dd className="font-mono text-lg font-semibold" data-testid="text-final-amount">{formatCents(amountToApprove)}</dd></div>
          <div><dt className="text-[10px] uppercase text-slate-500">Cap used</dt><dd className="font-mono text-sm">{s.capUsed}</dd></div>
        </dl>
      </div>
      <WeeksTable p={s} />
      <LinesTable p={s} onOpenSerial={onOpenSerial} exclusions={review.exclusions} onToggle={toggle}
        onNote={(lineId, note) => setReview({ ...review, exclusions: { ...review.exclusions, [lineId]: note } })} />
      <div className="flex flex-wrap items-end gap-3 border-t pt-3">
        {stale ? (
          <Button size="sm" variant="outline" disabled={busy || notesMissing} onClick={onRecheck} data-testid="button-recheck">
            <RefreshCw className="mr-1.5 h-4 w-4" /> Recheck with {Object.keys(review.exclusions).length} exclusion(s)
          </Button>
        ) : (
          <>
            <div>
              <label className="text-[11px] uppercase text-slate-500">Batch reference</label>
              <Input className="h-8 w-56" value={review.reference} maxLength={200} onChange={(e) => setReview({ ...review, reference: e.target.value })} placeholder="e.g. CN-2291" data-testid="input-reference" />
            </div>
            <Button size="sm" disabled={busy || !review.reference.trim() || !s.token} onClick={onApprove} data-testid="button-approve-close">
              <FileCheck2 className="mr-1.5 h-4 w-4" /> Approve & close{amountToApprove === 0 && " ($0.00)"}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={onRecheck} data-testid="button-refresh-final-check">
              <RefreshCw className="mr-1.5 h-4 w-4" /> Recheck latest evidence
            </Button>
          </>
        )}
        {stale && <span className="text-xs text-amber-700">Exclusions changed — recheck before approving.{notesMissing && " Every exclusion needs a note."}</span>}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onCancel} data-testid="button-cancel-review">{walkthrough ? "Exit walkthrough" : "Cancel"}</Button>
        {walkthrough && <Button size="sm" variant="ghost" onClick={onNext} data-testid="button-skip-partner">Skip partner</Button>}
      </div>
    </div>
  );
}

function PriorBatches({ batches }: { batches: ScanbackBatch[] }) {
  if (!batches.length) return null;
  return (
    <div className="mt-4">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Approved batches</p>
      <ul className="space-y-1 text-xs">
        {batches.map((b) => (
          <li key={b.id} className="flex flex-wrap items-center gap-3" data-testid={`batch-${b.id}`}>
            <span className="font-medium">{b.reference}</span>
            {b.historical && <span className="rounded bg-slate-200 px-1 text-[10px]">historical</span>}
            <span className="text-slate-500">{formatDateTime(b.createdAt)}</span>
            <span className="font-mono">{b.approvedCount} · {formatCents(b.totalCents)}</span>
            <a className="text-sky-800 hover:underline" href={batchUrl(b.id)} download data-testid={`link-batch-${b.id}`}>Statement XLSX</a>
          </li>
        ))}
      </ul>
    </div>
  );
}
