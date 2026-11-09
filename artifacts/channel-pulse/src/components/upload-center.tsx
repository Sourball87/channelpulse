import { useMemo, useState } from "react";
import { Link } from "wouter";
import type { Reseller, ScanbackProgram, UnmatchedProntoCredit } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { customerLabel } from "@/lib/customer-display";
import { formatWeekLabel, isoWeekDates } from "@/lib/week-display";
import {
  CENTER_KINDS, KIND_LABEL, KIND_SHORT, formatDay, isoWeekOf, lastCompletedSunday, shiftSunday, shortDate,
  usePatchCenterUpload, useResolveCredit, type CenterKind, type CenterUpload,
} from "@/lib/upload-center";
import { ChevronLeft, ChevronRight, ClipboardCopy, FileSpreadsheet, Lock, Pencil, ShieldCheck, Trash2, UploadCloud } from "lucide-react";

const NONE = "__none";
const n = (v: number | null | undefined) => (v ?? 0).toLocaleString("en-AU");

export function resellerFlag(r: unknown, field: "sends_soh" | "sends_serial_reports"): boolean {
  const v = (r as Record<string, unknown>)[field];
  return typeof v === "boolean" ? v : field === "sends_soh";
}

export function validIsoWeek(value: string): boolean {
  return !!isoWeekDates(value);
}

/* ------------------------------------------------------------------ */
/* Metadata editor (type / reseller / week)                            */
/* ------------------------------------------------------------------ */
export function MetaEditDialog({ upload, resellers, onClose }: { upload: CenterUpload | null; resellers: Reseller[]; onClose: () => void }) {
  return (
    <Dialog open={!!upload} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        {upload && <MetaEditBody key={upload.id} upload={upload} resellers={resellers} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function MetaEditBody({ upload, resellers, onClose }: { upload: CenterUpload; resellers: Reseller[]; onClose: () => void }) {
  const patch = usePatchCenterUpload();
  const { toast } = useToast();
  const [kind, setKind] = useState<CenterKind>(upload.kind);
  const [accountId, setAccountId] = useState<number | null>(upload.accountId);
  const [week, setWeek] = useState(upload.weekIso ?? "");
  const weekBad = !!week && !validIsoWeek(week);
  const save = () => patch.mutate(
    { id: upload.id, data: { kind, accountId, weekIso: week || null } },
    {
      onSuccess: () => { toast({ title: "Upload details updated", description: "Still pending. Review and commit when ready." }); onClose(); },
      onError: (e) => toast({ title: "Could not update", description: e instanceof Error ? e.message : undefined, variant: "destructive" }),
    },
  );
  return (
    <>
      <DialogHeader>
        <DialogTitle className="truncate">Correct file details</DialogTitle>
        <DialogDescription className="truncate">{upload.name}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-3">
        <label className="grid gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Type</span>
          <KindSelect value={kind} onChange={setKind} testId="select-edit-kind" />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Reseller</span>
          <ResellerSelect value={accountId} onChange={setAccountId} resellers={resellers} testId="select-edit-reseller" />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Reporting week (ISO, Mon-Sun)</span>
          <WeekSelect value={week} onChange={setWeek} allowNone testId="select-edit-week" />
          <Input className="font-mono" placeholder="2026-W27" value={week} onChange={(e) => setWeek(e.target.value.trim().toUpperCase())} data-testid="input-edit-week" aria-invalid={weekBad} />
          {weekBad ? <span className="text-xs text-destructive">Enter a valid ISO week.</span> : week ? <span className="text-xs text-muted-foreground">{formatWeekLabel(week)}</span> : null}
        </label>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={save} disabled={patch.isPending || weekBad} data-testid="button-save-meta">{patch.isPending ? "Saving..." : "Save details"}</Button>
      </DialogFooter>
    </>
  );
}

function WeekSelect({ value, onChange, allowNone = false, testId, extra = [] }: {
  value: string; onChange: (v: string) => void; allowNone?: boolean; testId: string; extra?: string[];
}) {
  const latest = lastCompletedSunday();
  const weeks = [...new Set([
    ...Array.from({ length: 105 }, (_, i) => isoWeekOf(shiftSunday(latest, 1 - i))),
    ...extra, ...(validIsoWeek(value) ? [value] : []),
  ])].sort().reverse();
  return (
    <Select value={value || NONE} onValueChange={v => onChange(v === NONE ? "" : v)}>
      <SelectTrigger className="h-9 min-w-[220px] text-xs" data-testid={testId} aria-label="Reporting week"><SelectValue /></SelectTrigger>
      <SelectContent>
        {allowNone && <SelectItem value={NONE}>No reporting week</SelectItem>}
        {weeks.map(w => <SelectItem key={w} value={w}>{formatWeekLabel(w)}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export function KindSelect({ value, onChange, testId, className }: { value: CenterKind; onChange: (k: CenterKind) => void; testId?: string; className?: string }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as CenterKind)}>
      <SelectTrigger className={className} data-testid={testId}><SelectValue /></SelectTrigger>
      <SelectContent>{CENTER_KINDS.map((k) => <SelectItem key={k} value={k}>{KIND_LABEL[k]}</SelectItem>)}</SelectContent>
    </Select>
  );
}

export function ResellerSelect({ value, onChange, resellers, testId, className }: { value: number | null; onChange: (v: number | null) => void; resellers: Reseller[]; testId?: string; className?: string }) {
  return (
    <Select value={value == null ? NONE : String(value)} onValueChange={(v) => onChange(v === NONE ? null : Number(v))}>
      <SelectTrigger className={className} data-testid={testId}><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>No reseller</SelectItem>
        {resellers.map((r) => <SelectItem key={r.id} value={String(r.id)}>{customerLabel(r.code)}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export function KindBadge({ kind }: { kind: CenterKind }) {
  const tone: Record<CenterKind, string> = {
    soh: "bg-sky-50 text-sky-800 border-sky-200",
    claim: "bg-cyan-50 text-cyan-800 border-cyan-200",
    evidence: "bg-indigo-50 text-indigo-800 border-indigo-200",
    history: "bg-slate-100 text-slate-700 border-slate-200",
    price: "bg-emerald-50 text-emerald-800 border-emerald-200",
    program: "bg-violet-50 text-violet-800 border-violet-200",
    unknown: "bg-amber-50 text-amber-800 border-amber-300",
  };
  return <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium ${tone[kind]}`}>{KIND_SHORT[kind]}</span>;
}

export function StateBadge({ u }: { u: CenterUpload }) {
  if (u.state === "committed")
    return <Badge className="gap-1 border-emerald-500/20 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/10"><Lock className="h-3 w-3" />Committed</Badge>;
  if (u.state === "superseded")
    return <Badge variant="secondary" className="border-slate-500/20 bg-slate-500/10 text-slate-600">Superseded</Badge>;
  return <Badge variant="secondary" className="border-amber-500/20 bg-amber-500/10 text-amber-700">Pending</Badge>;
}

/* ------------------------------------------------------------------ */
/* Weekly view                                                          */
/* ------------------------------------------------------------------ */
type CardStatus = "received" | "missing" | "not_expected";

export function WeeklyView({
  uploads, resellers, programs, onDropFiles, uploading,
}: {
  uploads: CenterUpload[]; resellers: Reseller[]; programs: ScanbackProgram[];
  onDropFiles: (files: File[], accountId: number, weekIso: string, kind: CenterKind) => void;
  uploading: boolean;
}) {
  const { toast } = useToast();
  const [sunday, setSunday] = useState(() => lastCompletedSunday());
  const latest = lastCompletedSunday();
  const week = isoWeekOf(sunday);
  const active = resellers.filter((r) => r.active !== false);
  const committed = useMemo(() => uploads.filter((u) => u.state === "committed" && u.weekIso === week), [uploads, week]);

  const rows = active.map((r) => {
    const soh = committed.filter((u) => u.kind === "soh" && u.accountId === r.id);
    const ser = committed.filter((u) => u.kind === "claim" && u.accountId === r.id);
    const status = (files: CenterUpload[], expected: boolean): CardStatus => files.length ? "received" : expected ? "missing" : "not_expected";
    return { r, soh, ser, sohStatus: status(soh, resellerFlag(r, "sends_soh")), serStatus: status(ser, resellerFlag(r, "sends_serial_reports")) };
  });
  const missingSoh = rows.filter((x) => x.sohStatus === "missing").map((x) => x.r);
  const missingSer = rows.filter((x) => x.serStatus === "missing").map((x) => x.r);

  const copyChase = async () => {
    const lines: string[] = [];
    let i = 1;
    const ending = formatDay(sunday);
    for (const r of missingSoh) lines.push(`${i++}. ${customerLabel(r.code)} - SOH report, week ending ${ending}`);
    for (const r of missingSer) lines.push(`${i++}. ${customerLabel(r.code)} - serial report, week ending ${ending}`);
    const nonSerialReports = uploads.filter((u) => u.state === "committed" && u.kind === "claim" && u.weekIso === week && u.summary.nonSerialCount > 0);
    for (const report of nonSerialReports) {
      const code = resellers.find((r) => r.id === report.accountId)?.code;
      const identifiers = report.summary.nonSerialIdentifiers ?? [];
      if (identifiers.length) {
        for (const identifier of identifiers)
          lines.push(`${i++}. ${customerLabel(code ?? "Unknown")} - verify non-serial barcode/part label ${identifier} from ${report.name}`);
      } else {
        lines.push(`${i++}. ${customerLabel(code ?? "Unknown")} - verify ${report.summary.nonSerialCount} non-serial barcode/part-label entries from ${report.name}`);
      }
    }
    const text = lines.length ? lines.join("\n") : `All expected reports received for week ending ${ending}.`;
    try { await navigator.clipboard.writeText(text); toast({ title: "Chase list copied", description: `${lines.length} outstanding report${lines.length === 1 ? "" : "s"}.` }); }
    catch { toast({ title: "Could not copy", description: text, variant: "destructive" }); }
  };

  return (
    <section className="space-y-4" data-testid="section-weekly">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-background px-4 py-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" className="h-8 w-8" aria-label="Previous week" data-testid="button-week-prev" onClick={() => setSunday((d) => shiftSunday(d, -1))}><ChevronLeft className="h-4 w-4" /></Button>
          <div className="min-w-[220px] text-center">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Week ending Sunday</p>
            <div data-testid="text-week-ending">
              <WeekSelect value={week} testId="select-reporting-week" extra={uploads.map(u => u.weekIso).filter((w): w is string => !!w)}
                onChange={w => { const days = isoWeekDates(w); if (days) setSunday(days.end); }} />
            </div>
          </div>
          <Button variant="outline" size="icon" className="h-8 w-8" aria-label="Next week" data-testid="button-week-next" onClick={() => setSunday((d) => shiftSunday(d, 1))}><ChevronRight className="h-4 w-4" /></Button>
          {sunday.getTime() !== latest.getTime() && <Button variant="ghost" size="sm" onClick={() => setSunday(latest)} data-testid="button-week-latest">Latest</Button>}
        </div>
        <p className="flex-1 text-sm" data-testid="text-missing-summary">
          <span className={missingSoh.length ? "text-rose-700" : "text-emerald-700"}>Missing SOH: {missingSoh.length ? missingSoh.map((r) => customerLabel(r.code)).join(", ") : "none"}</span>
          <span className="mx-2 text-muted-foreground">&middot;</span>
          <span className={missingSer.length ? "text-rose-700" : "text-emerald-700"}>Missing serial reports: {missingSer.length ? missingSer.map((r) => customerLabel(r.code)).join(", ") : "none"}</span>
        </p>
        <Button variant="outline" size="sm" onClick={copyChase} data-testid="button-copy-chase"><ClipboardCopy className="mr-1.5 h-4 w-4" /> Copy chase list</Button>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <div className="space-y-2">
          <SectionHead title="Customer SOH" received={rows.filter((x) => x.sohStatus === "received").length} expected={rows.filter((x) => x.sohStatus !== "not_expected").length} />
          <div className="grid gap-2 sm:grid-cols-2">
            {rows.map((x) => (
              <ResellerCard key={x.r.id} reseller={x.r} status={x.sohStatus} files={x.soh} kind="soh" week={week} uploading={uploading} onDropFiles={onDropFiles}>
                {x.soh.length > 0 && (
                  <p className="font-mono text-[11px] text-slate-600" data-testid={`text-soh-summary-${x.r.id}`}>
                    {n(x.soh.reduce((s, u) => s + u.summary.skuCount, 0))} SKUs &middot; {n(x.soh.reduce((s, u) => s + u.summary.soh, 0))} SOH &middot; {n(x.soh.reduce((s, u) => s + u.summary.unitsSold, 0))} sold
                  </p>
                )}
              </ResellerCard>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <SectionHead title="Serial reports" received={rows.filter((x) => x.serStatus === "received").length} expected={rows.filter((x) => x.serStatus !== "not_expected").length} />
          <div className="grid gap-2 sm:grid-cols-2">
            {rows.map((x) => (
              <ResellerCard key={x.r.id} reseller={x.r} status={x.serStatus} files={x.ser} kind="claim" week={week} uploading={uploading} onDropFiles={onDropFiles}>
                {x.ser.map((u) => <SerialSummary key={u.id} u={u} reseller={x.r} programs={programs} week={week} />)}
              </ResellerCard>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function SectionHead({ title, received, expected }: { title: string; received: number; expected: number }) {
  return (
    <div className="flex items-baseline justify-between">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-600">{title}</h3>
      <span className="font-mono text-xs text-muted-foreground">{received} of {expected} expected received</span>
    </div>
  );
}

function ResellerCard({
  reseller, status, files, kind, week, uploading, onDropFiles, children,
}: {
  reseller: Reseller; status: CardStatus; files: CenterUpload[]; kind: CenterKind; week: string; uploading: boolean;
  onDropFiles: (files: File[], accountId: number, weekIso: string, kind: CenterKind) => void; children?: React.ReactNode;
}) {
  const [over, setOver] = useState(false);
  const tone = status === "received" ? "border-l-emerald-500" : status === "missing" ? "border-l-rose-500" : "border-l-slate-300";
  const label = status === "received" ? "Received" : status === "missing" ? "Missing" : "Not expected";
  const labelTone = status === "received" ? "text-emerald-700" : status === "missing" ? "text-rose-700" : "text-slate-500";
  return (
    <div
      data-testid={`card-${kind}-${reseller.id}`}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault(); e.stopPropagation(); setOver(false);
        const fl = Array.from(e.dataTransfer.files);
        if (fl.length && !uploading) onDropFiles(fl, reseller.id, week, kind);
      }}
      className={`relative rounded-md border border-l-4 bg-background p-3 transition-colors ${tone} ${over ? "bg-cyan-50 ring-2 ring-cyan-400" : ""} ${status === "not_expected" ? "opacity-75" : ""}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-sm font-semibold">{customerLabel(reseller.code)}</span>
        <span className={`text-[11px] font-semibold uppercase tracking-wider ${labelTone}`} data-testid={`status-${kind}-${reseller.id}`}>{label}</span>
      </div>
      {files.map((f) => (
        <p key={f.id} className="mt-1 flex items-center gap-1 truncate text-xs text-slate-600" title={f.name}>
          <FileSpreadsheet className="h-3 w-3 shrink-0 text-slate-400" /><span className="truncate">{f.name}</span>
        </p>
      ))}
      <div className="mt-1 space-y-1">{children}</div>
      {over && <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-cyan-50/90 text-xs font-medium text-cyan-800"><UploadCloud className="mr-1 h-4 w-4" />Drop for {customerLabel(reseller.code)} &middot; {week}</div>}
    </div>
  );
}

function SerialSummary({ u, reseller, programs, week }: { u: CenterUpload; reseller: Reseller; programs: ScanbackProgram[]; week: string }) {
  const s = u.summary;
  const wd = isoWeekDates(week);
  const from = (s.from || wd?.start.toISOString() || "").slice(0, 10);
  const to = (s.to || wd?.end.toISOString() || "").slice(0, 10);
  const applicable = programs.filter((p) => !p.archived && p.customerIds.includes(reseller.id) &&
    (!from || !to || (p.start.slice(0, 10) <= to && p.end.slice(0, 10) >= from)));
  const [chosen, setChosen] = useState("");
  const promotion = applicable.length === 1 ? applicable[0].id : chosen;
  const params = new URLSearchParams();
  params.set("report", u.sourceId ?? u.id);
  params.set("reseller", String(reseller.id));
  if (promotion) params.set("promotion", promotion);
  return (
    <div className="space-y-1.5" data-testid={`summary-serial-${u.id}`}>
      <p className="font-mono text-[11px] text-slate-600">
        {n(s.serialCount)} serials &middot; {n(s.skuCount)} SKUs &middot; {shortDate(s.from)} - {shortDate(s.to)}
      </p>
      {!!s.nonSerialCount && (
        <p className="text-[11px] text-amber-800">
          {n(s.nonSerialCount)} DigiDirect barcodes or part labels excluded from serial matching and added to the chase list.
        </p>
      )}
      <p className="text-[11px] text-slate-600"><span className="font-semibold tabular-nums">{n(s.invoicedCount)}</span> of {n(s.ddRangeCount)} reported serials in DD range invoiced to this customer <span className="text-muted-foreground">(coverage only, not eligibility)</span></p>
      <div className="flex flex-wrap items-center gap-1.5">
        {applicable.length > 1 && (
          <Select value={chosen} onValueChange={setChosen}>
            <SelectTrigger className="h-7 w-44 text-xs" data-testid={`select-promotion-${u.id}`}><SelectValue placeholder={`Choose promotion (${applicable.length})`} /></SelectTrigger>
            <SelectContent>{applicable.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
          </Select>
        )}
        {applicable.length === 1 && <span className="truncate text-[11px] text-cyan-800">{applicable[0].name}</span>}
        {applicable.length === 0 && <span className="text-[11px] text-amber-700">No active promotion for this customer and period</span>}
        {u.sourceId ? (
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" asChild disabled={applicable.length > 1 && !chosen} data-testid={`link-verify-${u.id}`}>
            <Link href={`/scanback?${params.toString()}`} onClick={(e) => { if (applicable.length > 1 && !chosen) e.preventDefault(); }}
              className={applicable.length > 1 && !chosen ? "pointer-events-none opacity-50" : ""}>
              <ShieldCheck className="mr-1 h-3 w-3" /> Verify claim
            </Link>
          </Button>
        ) : <span className="text-[11px] text-muted-foreground">Not linked to a claim import</span>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* DD data panel                                                         */
/* ------------------------------------------------------------------ */
export function DdDataPanel({ uploads, priceCount, pricesUpdated, credits, resellers }: {
  uploads: CenterUpload[];
  priceCount: number;
  pricesUpdated: string | null;
  credits: UnmatchedProntoCredit[];
  resellers: Reseller[];
}) {
  const [credit, setCredit] = useState<UnmatchedProntoCredit | null>(null);
  const [mode, setMode] = useState<"serials" | "reviewed">("serials");
  const [serialText, setSerialText] = useState("");
  const [note, setNote] = useState("");
  const resolve = useResolveCredit();
  const { toast } = useToast();
  const serials = serialText.split(/[|,;\n]+/).map(s => s.trim()).filter(Boolean);
  const canResolve = !!credit && (mode === "serials"
    ? serials.length === Math.abs(credit.quantity)
    : !!note.trim());
  const openCredit = (item: UnmatchedProntoCredit) => {
    setCredit(item); setMode("serials"); setSerialText(""); setNote("");
  };
  const submitResolution = () => {
    if (!credit || !canResolve) return;
    resolve.mutate({
      importId: credit.importId,
      sourceRow: credit.sourceRow,
      data: mode === "serials" ? { mode, serials } : { mode, note: note.trim() },
    }, {
      onSuccess: () => {
        setCredit(null);
        toast({ title: "Pronto credit resolved", description: "The review hold is cleared and the resolution is recorded in the audit history." });
      },
      onError: error => toast({
        title: "Could not resolve credit",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      }),
    });
  };
  const by = (k: CenterKind) => uploads.filter((u) => u.kind === k).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const evidence = by("evidence"), prices = by("price"), history = by("history");
  const latestEv = evidence.find((u) => u.state === "committed");
  const blocks: { title: string; testId: string; main: React.ReactNode; list: CenterUpload[] }[] = [
    {
      title: "Pronto serial report", testId: "dd-evidence", list: evidence,
      main: latestEv
        ? <><p className="font-mono text-sm">{shortDate(latestEv.summary.from)} - {shortDate(latestEv.summary.to)}</p><p className="text-xs text-slate-600">{n(latestEv.rowCount)} lines &middot; {n(latestEv.summary.serialCount)} serials</p></>
        : <p className="text-sm text-muted-foreground">No committed Pronto report yet.</p>,
    },
    {
      title: "Price list", testId: "dd-price", list: prices,
      main: priceCount
        ? <><p className="font-mono text-sm">{n(priceCount)} SKUs</p><p className="text-xs text-slate-600">Last updated {shortDate(pricesUpdated)}</p></>
        : <p className="text-sm text-muted-foreground">No price list stored yet.</p>,
    },
    {
      title: "Historical claims", testId: "dd-history", list: history,
      main: history.some((u) => u.state === "committed")
        ? <p className="font-mono text-sm">{n(history.filter((u) => u.state === "committed").reduce((s, u) => s + u.rowCount, 0))} rows across {history.filter((u) => u.state === "committed").length} files</p>
        : <p className="text-sm text-muted-foreground">No historical claims imported.</p>,
    },
  ];
  return (
    <section className="space-y-2" data-testid="section-dd-data">
      <h2 className="text-lg font-semibold">DD data</h2>
      <div className="grid gap-3 lg:grid-cols-[1.3fr_1fr_1fr]">
        {blocks.map((b) => (
          <div key={b.title} className="rounded-lg border bg-background" data-testid={b.testId}>
            <div className="border-b px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{b.title}</p>
              <div className="mt-1">{b.main}</div>
            </div>
            <ul className="max-h-40 divide-y overflow-y-auto text-xs">
              {b.list.length === 0 && <li className="px-4 py-2 text-muted-foreground">No uploads.</li>}
              {b.list.map((u) => (
                <li key={u.id} className="flex items-center justify-between gap-2 px-4 py-1.5">
                  <span className="truncate" title={u.name}>{u.name}</span>
                  <span className={`shrink-0 font-mono ${u.state === "committed" ? "text-emerald-700" : u.state === "superseded" ? "text-slate-500" : "text-amber-700"}`}>
                    {shortDate(u.createdAt)} &middot; {u.state === "superseded" ? "superseded" : u.state === "committed" ? "committed" : "pending"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="rounded-lg border bg-background" data-testid="unmatched-pronto-credits">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <div>
            <p className="text-sm font-semibold">Unmatched credits</p>
            <p className="text-xs text-muted-foreground">These credits hold matching reseller/SKU claims for review until resolved.</p>
          </div>
          <Badge variant={credits.length ? "secondary" : "outline"}>{credits.length} unresolved</Badge>
        </div>
        {credits.length === 0 ? <p className="px-4 py-3 text-sm text-muted-foreground">No unmatched Pronto credits.</p> : (
          <div className="max-h-72 overflow-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Reseller</TableHead><TableHead>SKU</TableHead><TableHead>Invoice</TableHead>
                <TableHead>Date</TableHead><TableHead className="text-right">Qty</TableHead><TableHead />
              </TableRow></TableHeader>
              <TableBody>{credits.map(item => (
                <TableRow key={item.id}>
                  <TableCell>{customerLabel(resellers.find(r => r.id === item.accountId)?.code ?? item.accountCode)}</TableCell>
                  <TableCell className="font-mono text-xs">{item.sku}</TableCell>
                  <TableCell className="font-mono text-xs">{item.invoice || "—"}</TableCell>
                  <TableCell>{shortDate(item.date)}</TableCell>
                  <TableCell className="text-right tabular-nums">{item.quantity}</TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" onClick={() => openCredit(item)} data-testid={`button-resolve-credit-${item.sourceRow}`}>
                      Resolve
                    </Button>
                  </TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          </div>
        )}
      </div>
      <Dialog open={!!credit} onOpenChange={open => { if (!open && !resolve.isPending) setCredit(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resolve unmatched credit</DialogTitle>
            <DialogDescription>
              {credit && `${customerLabel(resellers.find(r => r.id === credit.accountId)?.code ?? credit.accountCode)} · ${credit.sku} · Invoice ${credit.invoice || "—"} · ${shortDate(credit.date)} · Qty ${credit.quantity}`}
            </DialogDescription>
          </DialogHeader>
          <label className="grid gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Resolution</span>
            <Select value={mode} onValueChange={value => setMode(value as "serials" | "reviewed")}>
              <SelectTrigger data-testid="select-credit-resolution-mode"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="serials">Enter returned serials</SelectItem>
                <SelectItem value="reviewed">Mark reviewed with note</SelectItem>
              </SelectContent>
            </Select>
          </label>
          {mode === "serials" ? (
            <label className="grid gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">Returned serials, one per line or separated by commas</span>
              <Textarea rows={4} value={serialText} onChange={event => setSerialText(event.target.value)}
                placeholder="ABC123456" data-testid="textarea-credit-serials" />
              {credit && <span className="text-xs text-muted-foreground">
                Enter {Math.abs(credit.quantity)} serial(s); {serials.length} entered.
              </span>}
            </label>
          ) : (
            <label className="grid gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">Review note</span>
              <Textarea rows={4} value={note} onChange={event => setNote(event.target.value)}
                placeholder="Describe what was checked." data-testid="textarea-credit-review-note" />
            </label>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCredit(null)} disabled={resolve.isPending}>Cancel</Button>
            <Button onClick={submitResolution} disabled={!canResolve || resolve.isPending} data-testid="button-submit-credit-resolution">
              {resolve.isPending ? "Saving..." : "Resolve credit"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* All uploads                                                           */
/* ------------------------------------------------------------------ */
export function AllUploadsTable({
  uploads, resellers, loading, onEdit, onDelete, onReview,
}: {
  uploads: CenterUpload[]; resellers: Reseller[]; loading: boolean;
  onEdit: (u: CenterUpload) => void; onDelete: (u: CenterUpload) => void; onReview: (u: CenterUpload) => void;
}) {
  const [kind, setKind] = useState<string>("all");
  const resById = new Map(resellers.map((r) => [r.id, r]));
  const list = uploads.filter((u) => kind === "all" || u.kind === kind).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <section className="space-y-2" data-testid="section-all-uploads">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">All uploads</h2>
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="h-8 w-56" data-testid="select-filter-kind"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {CENTER_KINDS.map((k) => <SelectItem key={k} value={k}>{KIND_LABEL[k]}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="overflow-x-auto rounded-lg border bg-background">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow><TableHead>Type</TableHead><TableHead>Reseller</TableHead><TableHead>Week</TableHead><TableHead>File</TableHead><TableHead className="text-right">Rows</TableHead><TableHead>Uploaded</TableHead><TableHead>State</TableHead><TableHead className="text-right">Actions</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {loading ? Array.from({ length: 4 }).map((_, i) => (
              <TableRow key={i}><TableCell colSpan={8}><Skeleton className="h-5 w-full" /></TableCell></TableRow>
            )) : list.length === 0 ? (
              <TableRow><TableCell colSpan={8} className="h-24 text-center text-sm text-muted-foreground">No uploads of this type yet. Drop files into the zone above.</TableCell></TableRow>
            ) : list.map((u) => (
              <TableRow key={u.id} data-testid={`row-upload-${u.id}`}>
                <TableCell><KindBadge kind={u.kind} /></TableCell>
                <TableCell className="font-mono text-xs">{u.accountId == null ? "-" : customerLabel(resById.get(u.accountId)?.code ?? u.accountId)}</TableCell>
                <TableCell className="font-mono text-xs">{u.weekIso ?? "-"}</TableCell>
                <TableCell className="max-w-[280px] truncate text-sm" title={u.name}>{u.name}</TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">{n(u.rowCount)}</TableCell>
                <TableCell className="font-mono text-xs">{shortDate(u.createdAt)}</TableCell>
                <TableCell><StateBadge u={u} /></TableCell>
                <TableCell className="whitespace-nowrap text-right">
                  {u.state === "preview" ? (
                    <>
                      <Button variant="outline" size="sm" className="mr-1 h-7" onClick={() => onReview(u)} data-testid={`button-review-${u.id}`}>Review</Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Edit details" onClick={() => onEdit(u)} data-testid={`button-edit-${u.id}`}><Pencil className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-rose-600 hover:bg-rose-50" aria-label="Delete pending upload" onClick={() => onDelete(u)} data-testid={`button-delete-${u.id}`}><Trash2 className="h-3.5 w-3.5" /></Button>
                    </>
                  ) : <span className="text-[11px] text-muted-foreground">Immutable</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
