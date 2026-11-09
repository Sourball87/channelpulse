import { formatWeekLabel } from "@/lib/week-display";
import { useState, useRef, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { useGetResellers, type Reseller } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { UploadCloud, FileText, AlertCircle, TriangleAlert, Trash2, Pencil, CheckCircle2, X, RefreshCw, ExternalLink } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { trackEvent } from "@/lib/analytics";
import { UploadDiagnostics } from "@/components/upload-diagnostics";
import { customerLabel } from "@/lib/customer-display";
import { ImportPanel } from "@/components/scanback/import-panel";
import { useScanbackWorkspace } from "@/components/scanback/shared";
import {
  AllUploadsTable, DdDataPanel, KindBadge, MetaEditDialog, StateBadge, WeeklyView,
} from "@/components/upload-center";
import {
  KIND_LABEL, useCenterUpload, useCommitCenterUpload, useDeleteCenterUpload, usePatchCenterUpload, useUploadCenter,
  type CenterKind, type CenterUpload,
} from "@/lib/upload-center";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Extract a meaningful, reseller-distinct token from a filename for pattern matching. */
function extractFileToken(filename: string): string | null {
  const GENERIC = new Set(["samsung", "report", "weekly", "stock", "inventory", "data", "export", "soh", "sell"]);
  const parts = filename.replace(/\.[^.]+$/, "").split(/[._\-\s]+/);
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower.length <= 3) continue;                        // too short
    if (/^\d+$/.test(lower)) continue;                     // purely numeric
    if (/^(19|20)\d{2}/.test(lower) && lower.length <= 8) continue; // year/date prefix
    if (GENERIC.has(lower)) continue;                       // generic word
    return lower;
  }
  return null;
}

const CANONICAL_FIELDS = [
  { value: "ignore", label: "Ignore / Do not map" },
  { value: "part_no", label: "Part Number" },
  { value: "soh", label: "Stock on Hand (SOH)" },
  { value: "sell_through_7d", label: "Sell Through (ST)" },
  { value: "sold_mtd", label: "Sold MTD" },
  { value: "sold_14d", label: "Sold Last 14 Days" },
  { value: "sold_30d", label: "Sold Last 30 Days" },
  { value: "on_order", label: "On Order" },
  { value: "avg_cost", label: "Average Cost" }
];

function validWeek(value: string): boolean {
  const match = /^(\d{4})-W(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]), week = Number(match[2]);
  if (year < 1900 || year > 2100 || week < 1 || week > 53) return false;
  // December 28 is always in the final ISO week of its year.
  const d = new Date(Date.UTC(year, 11, 28));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const weeks = Math.ceil(((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
  return week <= weeks;
}

interface CommitData {
  mappings: any[];
  resellerId: number | null;
  weekIso: string;
  rememberPattern: boolean;
}

interface ConflictState {
  centerUploadId: string;
  uploadId: number;
  resellerId: number;
  weekIso: string;
  mappings: any[];
  existingCount: number;
  message: string;
}

const REFERENCE_FIELDS: Record<"price" | "program", { key: string; label: string; required: boolean }[]> = {
  price: [
    { key: "sku", label: "SKU", required: true },
    { key: "description", label: "Description", required: false },
    { key: "rrpIncCents", label: "RRP Inc", required: true },
    { key: "ddCostExCents", label: "DD Cost Ex", required: true },
    { key: "t1BuyExCents", label: "T1 Buy Ex", required: true },
  ],
  program: [
    { key: "sku", label: "SKU", required: true },
    { key: "gtmBuyCents", label: "GTM Buy Ex", required: true },
  ],
};
const UNMAPPED = "__unmapped";

export default function UploadCenter() {
  const [isDragging, setIsDragging] = useState(false);
  const [defaultWeek, setDefaultWeek] = useState("");
  const [aiAssist, setAiAssist] = useState(true);
  const [conflictInfo, setConflictInfo] = useState<ConflictState | null>(null);
  const [isConfirmingOverwrite, setIsConfirmingOverwrite] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CenterUpload | null>(null);
  const [editTarget, setEditTarget] = useState<CenterUpload | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const reviewRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const center = useUploadCenter();
  const sendFiles = useCenterUpload();
  const deleteCenter = useDeleteCenterUpload();
  const { data: resellerData } = useGetResellers();
  const ws = useScanbackWorkspace();
  const resellers: Reseller[] = resellerData ?? [];
  const uploads = center.data?.uploads ?? [];
  const pending = useMemo(() => uploads.filter((u) => u.state === "preview").sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [uploads]);
  const open = uploads.find((u) => u.id === openId) ?? null;
  const resById = new Map(resellers.map((r) => [r.id, r]));
  const pricesUpdated = (center.data?.prices ?? []).reduce<string | null>((m, p) => (!m || p.updatedAt > m ? p.updatedAt : m), null);

  const reviewFromUpload = (u: CenterUpload) => ({
    ...((u.sohReview ?? {}) as Record<string, any>),
    center_upload_id: u.id,
  });

  const openReview = (u: CenterUpload) => {
    setOpenId(u.id);
    requestAnimationFrame(() => reviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const processFiles = (files: File[], opts: { accountId?: number | null; weekIso?: string | null; kind?: CenterKind } = {}) => {
    if (!files.length) return;
    const weekIso = opts.weekIso ?? (defaultWeek || null);
    if (weekIso && !validWeek(weekIso)) {
      toast({ title: "Check the default week", description: "Enter a valid ISO week or leave it blank.", variant: "destructive" });
      return;
    }
    trackEvent("upload_started", { file_count: files.length });
    const tooBig = files.filter((f) => f.size > 50 * 1024 * 1024);
    if (tooBig.length) toast({ title: "Files over 50 MB skipped", description: tooBig.map((f) => f.name).join(", "), variant: "destructive" });
    const ok = files.filter((f) => f.size <= 50 * 1024 * 1024);
    if (!ok.length) return;
    const batches: File[][] = [];
    for (let i = 0; i < ok.length; i += 20) batches.push(ok.slice(i, i + 20));
    const run = async () => {
      const all = { uploads: [] as CenterUpload[], errors: [] as { name: string; error: string }[] };
      for (const b of batches) {
        try {
          const r = await sendFiles.mutateAsync({ files: b, accountId: opts.accountId ?? null, weekIso, kind: opts.kind, aiAssist });
          all.uploads.push(...r.uploads); all.errors.push(...r.errors);
        } catch (e) {
          all.errors.push(...b.map((f) => ({ name: f.name, error: e instanceof Error ? e.message : "Upload failed" })));
        }
      }
      return all;
    };
    void run().then((r) => {
      {
        trackEvent("upload_processed", { file_count: r.uploads.length, failed_count: r.errors.length });
        toast({ title: `${r.uploads.length} file${r.uploads.length === 1 ? "" : "s"} staged for review`, description: "Nothing is committed until you review each file." });
        if (r.errors.length) toast({ title: "Some files could not be read", description: r.errors.map((e) => `${e.name}: ${e.error}`).join("; "), variant: "destructive" });
        if (r.uploads.length === 1) openReview(r.uploads[0]);
      }
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    deleteCenter.mutate(target.id, {
      onSuccess: () => {
        trackEvent("upload_deleted", { was_committed: false });
        toast({ title: "Pending upload deleted", description: `"${target.name}" has been removed.` });
        if (openId === target.id) setOpenId(null);
        setDeleteTarget(null);
      },
      onError: (e) => { toast({ title: "Failed to delete upload", description: e instanceof Error ? e.message : undefined, variant: "destructive" }); setDeleteTarget(null); },
    });
  };

  const doCommit = async (centerUploadId: string, uploadId: number, resellerId: number, weekIso: string, mappings: any[], confirmOverwrite: boolean) => {
    trackEvent("upload_commit_started", { overwrite: confirmOverwrite, mapping_count: mappings.length });
    let response: Response;
    try {
      response = await fetch(`/api/upload-center/${encodeURIComponent(centerUploadId)}/commit`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reseller_id: resellerId, week_iso: weekIso, mappings, confirm_overwrite: confirmOverwrite }),
      });
    } catch {
      toast({ title: "Failed to commit upload", variant: "destructive" });
      return false;
    }
    if (response.status === 409) {
      const data = await response.json();
      if (data.error === "conflict" && Number.isInteger(data.existing_count)) {
        setConflictInfo({ centerUploadId, uploadId, resellerId, weekIso, mappings, existingCount: data.existing_count, message: data.message });
      } else {
        toast({ title: "Upload changed", description: data.error ?? "Refresh and check this upload before continuing.", variant: "destructive" });
        queryClient.invalidateQueries();
      }
      return false;
    }
    if (!response.ok) {
      const details = await response.json().catch(() => null);
      toast({ title: "Failed to commit upload", description: details?.error ?? "Please check the mappings and try again.", variant: "destructive" });
      return false;
    }
    trackEvent("upload_committed", { overwrite: confirmOverwrite, mapping_count: mappings.length });
    return true;
  };

  const handleCommitReview = async (review: any, commitData: CommitData) => {
    const { mappings, resellerId, weekIso, rememberPattern } = commitData;
    if (!resellerId || !weekIso) {
      toast({ title: "Missing metadata", description: "Select a reseller and enter a week to commit.", variant: "destructive" });
      return;
    }
    const ok = await doCommit(review.center_upload_id, review.upload_id, resellerId, weekIso, mappings, false);
    if (!ok) return;
    if (rememberPattern && review.filename) {
      const token = extractFileToken(review.filename);
      if (token) {
        try {
          const resellerResp = await fetch("/api/resellers", { credentials: "include" });
          const allRes: any[] = resellerResp.ok ? await resellerResp.json() : [];
          const currentPatterns: string[] = allRes.find((r: any) => r.id === resellerId)?.filename_patterns ?? [];
          if (!currentPatterns.includes(token)) {
            await fetch(`/api/resellers/${resellerId}`, {
              method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ filename_patterns: [...currentPatterns, token] }),
            });
          }
        } catch { /* non-fatal */ }
      }
    }
    toast({ title: "SOH report committed" });
    setOpenId(null);
    queryClient.invalidateQueries();
  };

  const handleConfirmOverwrite = async () => {
    if (!conflictInfo) return;
    setIsConfirmingOverwrite(true);
    const { centerUploadId, uploadId, resellerId, weekIso, mappings } = conflictInfo;
    setConflictInfo(null);
    const ok = await doCommit(centerUploadId, uploadId, resellerId, weekIso, mappings, true);
    setIsConfirmingOverwrite(false);
    if (ok) {
      toast({ title: "SOH report committed - existing data replaced" });
      setOpenId(null);
      queryClient.invalidateQueries();
    }
  };

  const busy = sendFiles.isPending;

  return (
    <div className="flex flex-col h-full bg-muted/20">
      <header className="flex-none bg-background border-b px-6 py-4">
        <h1 className="text-2xl font-semibold tracking-tight">Upload Center</h1>
        <p className="text-sm text-muted-foreground">Every file enters ChannelPulse here: customer SOH and serial reports, Pronto DD serials, price lists and program tables.</p>
      </header>

      <div className="flex-1 overflow-auto p-4 md:p-6 space-y-8">
        {/* Drop zone */}
        <div
          data-testid="dropzone-main"
          className={`rounded-xl border-2 border-dashed p-8 md:p-10 transition-colors ${isDragging ? "border-primary bg-primary/5" : "border-border bg-card"}`}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => { e.preventDefault(); setIsDragging(false); processFiles(Array.from(e.dataTransfer.files)); }}
        >
          <input type="file" ref={fileInputRef} className="hidden" accept=".xlsx,.xls,.csv" multiple data-testid="input-center-files"
            onChange={(e) => e.target.files && processFiles(Array.from(e.target.files))} />
          <div className="flex flex-col gap-6 md:flex-row md:items-center">
            <div className="flex flex-1 items-center gap-4">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-muted">
                <UploadCloud className={`h-7 w-7 ${isDragging ? "text-primary" : "text-muted-foreground"}`} />
              </div>
              <div>
                <h3 className="text-lg font-semibold">Drop any number of CSV, XLS or XLSX files</h3>
                <p className="text-sm text-muted-foreground max-w-xl">
                  Type, reseller and week are detected from headings, sheet names and file names. Every file is staged as pending;
                  you confirm each one before anything is committed. Drop onto a reseller card below to pin the reseller and week.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label htmlFor="default-week" className="text-xs">Week for undated files (optional)</Label>
                <Input id="default-week" placeholder="2026-W27" value={defaultWeek} className="w-[130px] font-mono h-9"
                  aria-invalid={!!defaultWeek && !validWeek(defaultWeek)} data-testid="input-default-week"
                  onChange={(e) => setDefaultWeek(e.target.value.trim().toUpperCase())} />
              </div>
              <Button onClick={() => fileInputRef.current?.click()} disabled={busy} data-testid="button-choose-files">
                {busy ? "Reading files..." : "Choose files"}
              </Button>
            </div>
          </div>
          {!!defaultWeek && !validWeek(defaultWeek) && <p className="mt-2 text-sm text-destructive">Enter a valid ISO week, for example 2026-W27.</p>}
        </div>

        {/* Pending queue */}
        <section className="space-y-3" data-testid="section-pending">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-amber-500" /> Pending review <span className="font-mono text-sm text-muted-foreground">({pending.length})</span>
            </h2>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox checked={aiAssist} onCheckedChange={(v) => setAiAssist(v === true)} data-testid="checkbox-ai-assist" />
              AI suggestions for unclear files and SOH recognition
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            AI assistance uses Replit AI Integrations, requires no API key, and is billed to your credits.
            Only unclear metadata is sent, never inventory quantities or financial rows. You confirm all suggestions.
          </p>
          {center.isLoading ? (
            <div className="space-y-2"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
          ) : center.isError ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
              Could not load uploads. <Button size="sm" variant="outline" className="ml-2" onClick={() => center.refetch()} data-testid="button-retry-center">Retry</Button>
            </div>
          ) : pending.length === 0 ? (
            <div className="rounded-lg border bg-background px-4 py-6 text-center text-sm text-muted-foreground">Nothing waiting. Every staged file has been committed or removed.</div>
          ) : (
            <div className="divide-y rounded-lg border bg-background">
              {pending.map((u) => (
                <div key={u.id} className={`flex flex-wrap items-center gap-3 px-4 py-2.5 ${openId === u.id ? "bg-cyan-50/60" : ""}`} data-testid={`row-pending-${u.id}`}>
                  <KindBadge kind={u.kind} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium" title={u.name}>{u.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {u.accountId == null ? "no reseller" : customerLabel(resById.get(u.accountId)?.code ?? u.accountId)} &middot; {u.weekIso ?? "no week"} &middot; {u.rowCount.toLocaleString()} rows
                  </span>
                  {u.errors.length > 0 && <Badge variant="destructive" className="bg-rose-500/10 text-rose-700 border-rose-500/20">{u.errors.length} issues</Badge>}
                  <div className="flex gap-1">
                    <Button size="sm" variant={openId === u.id ? "default" : "outline"} className="h-7" onClick={() => openReview(u)} data-testid={`button-open-${u.id}`}>Review</Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Edit details" onClick={() => setEditTarget(u)} data-testid={`button-pending-edit-${u.id}`}><Pencil className="h-3.5 w-3.5" /></Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-rose-600 hover:bg-rose-50" aria-label="Delete" onClick={() => setDeleteTarget(u)} data-testid={`button-pending-delete-${u.id}`}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Review workspace */}
        <div ref={reviewRef} className="scroll-mt-4">
          {open && (
            <section className="space-y-3 rounded-lg border-2 border-cyan-200 bg-background p-4" data-testid="section-review">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2"><KindBadge kind={open.kind} /><StateBadge u={open} /></div>
                  <p className="mt-1 truncate font-semibold" data-testid="text-review-name">{open.name}</p>
                  <p className="text-xs text-muted-foreground">
                     {KIND_LABEL[open.kind]} &middot; {open.accountId == null ? "No reseller" : customerLabel(resById.get(open.accountId)?.code ?? open.accountId)} &middot; {open.weekIso ? formatWeekLabel(open.weekIso) : "No week"} &middot; Week source: {open.weekSource === "file_dates" ? "dates in file" : open.weekSource === "manual" ? "manual selection" : open.weekSource === "ai_suggested" ? "AI suggestion" : open.weekSource === "filename" ? "filename" : "not detected"}
                  </p>
                </div>
                <div className="flex gap-2">
                  {open.state === "preview" && <Button size="sm" variant="outline" onClick={() => setEditTarget(open)} data-testid="button-review-edit"><Pencil className="mr-1 h-3.5 w-3.5" /> Correct type / reseller / week</Button>}
                  <Button size="sm" variant="ghost" onClick={() => setOpenId(null)} aria-label="Close review" data-testid="button-close-review"><X className="h-4 w-4" /></Button>
                </div>
              </div>
              {open.errors.length > 0 && (
                <div className="max-h-32 overflow-y-auto rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700">{open.errors.map((e, i) => <p key={i}>{e}</p>)}</div>
              )}
               {!!open.warnings?.length && (
                 <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                   {open.warnings.map((warning, i) => <p key={i}>{warning}</p>)}
                 </div>
               )}
              <PreviewTable u={open} />

              {open.kind === "unknown" && (
                <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  The type could not be decided from the headings, sheet names or file name. Choose the correct type to continue.
                </div>
              )}

              {open.kind === "soh" && (
                open.state === "committed" ? (
                  <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">This SOH report is committed and included in analytics.</p>
                ) : open.sohReview ? (
                  <ReviewCard
                    key={open.id}
                    review={reviewFromUpload(open)}
                    onCommit={(commitData) => handleCommitReview(reviewFromUpload(open), commitData)}
                    onDiscard={() => setDeleteTarget(open)}
                  />
                ) : <p className="text-sm text-muted-foreground">SOH recognition details are loading or unavailable for this file. Refresh, or correct its type.</p>
              )}

              {(open.kind === "claim" || open.kind === "evidence") && (
                open.sourceId && ws.data ? (
                  <ImportPanel imports={ws.data.imports} resellers={resellers} selectedId={open.sourceId}
                    onCommitted={() => { queryClient.invalidateQueries(); }} />
                ) : ws.isLoading ? <Skeleton className="h-40 w-full" /> : (
                  <p className="text-sm text-muted-foreground">This file is not yet linked to a financial import. Save its type again or refresh.</p>
                )
              )}
              {open.kind === "history" && (
                <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                  New historical-claim uploads are retired. Existing approved claims remain available in Claims History and still count toward duplicate checks.
                </p>
              )}

              {(open.kind === "price" || open.kind === "program") && (
                <ReferenceCommit key={open.id + open.kind} u={open} />
              )}
            </section>
          )}
        </div>

        <WeeklyView uploads={uploads} resellers={resellers} programs={ws.data?.programs ?? []} uploading={busy}
          onDropFiles={(files, accountId, weekIso, kind) => processFiles(files, { accountId, weekIso, kind })} />

        <DdDataPanel uploads={uploads} priceCount={center.data?.prices.length ?? 0} pricesUpdated={pricesUpdated}
          credits={center.data?.unmatchedCredits ?? []} resellers={resellers} />

        <AllUploadsTable uploads={uploads} resellers={resellers} loading={center.isLoading}
          onEdit={setEditTarget} onDelete={setDeleteTarget} onReview={openReview} />
      </div>

      <MetaEditDialog upload={editTarget} resellers={resellers} onClose={() => setEditTarget(null)} />

      <Dialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Trash2 className="h-5 w-5 text-rose-500" /> Delete pending upload?</DialogTitle>
            <DialogDescription>
              This removes <strong className="text-foreground">{deleteTarget?.name}</strong>. It has not been committed, so no reporting or claim data changes.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleteCenter.isPending} data-testid="button-confirm-delete">
              {deleteCenter.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!conflictInfo} onOpenChange={(o) => { if (!o) setConflictInfo(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><TriangleAlert className="h-5 w-5 text-amber-500" /> Overwrite existing data?</DialogTitle>
            <DialogDescription>{conflictInfo?.message}</DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will replace <strong>{conflictInfo?.existingCount}</strong> existing snapshot(s) for week <strong>{conflictInfo?.weekIso}</strong>.
            Other parts from this reseller for the same week are not affected.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConflictInfo(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleConfirmOverwrite} disabled={isConfirmingOverwrite} data-testid="button-confirm-overwrite">
              {isConfirmingOverwrite ? "Committing..." : "Yes, replace data"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PreviewTable({ u }: { u: CenterUpload }) {
  const headers = u.headers.length ? u.headers : Object.keys(u.preview[0] ?? {});
  if (!u.preview.length) return <p className="text-xs text-muted-foreground">No preview rows available.</p>;
  return (
    <div className="max-h-56 overflow-auto rounded-md border">
      <Table>
        <TableHeader className="bg-muted/50"><TableRow>{headers.map((h) => <TableHead key={h} className="whitespace-nowrap text-xs">{h}</TableHead>)}</TableRow></TableHeader>
        <TableBody>
          {u.preview.slice(0, 8).map((row, i) => (
            <TableRow key={i} className="font-mono text-[11px]">{headers.map((h) => <TableCell key={h} className="whitespace-nowrap py-1">{row[h] == null ? "" : String(row[h])}</TableCell>)}</TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="px-3 py-1 text-[11px] text-muted-foreground">First {Math.min(8, u.preview.length)} of {u.rowCount.toLocaleString()} rows.</p>
    </div>
  );
}

function ReferenceCommit({ u }: { u: CenterUpload }) {
  const fields = REFERENCE_FIELDS[u.kind as "price" | "program"];
  const [mapping, setMapping] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, u.mapping[f.key] ?? ""])));
  const [reviewed, setReviewed] = useState(false);
  const patch = usePatchCenterUpload();
  const commit = useCommitCenterUpload();
  const { toast } = useToast();
  const dirty = fields.some((f) => (mapping[f.key] ?? "") !== (u.mapping[f.key] ?? ""));
  const missing = fields.filter((f) => f.required && !mapping[f.key]);
  const committed = u.state === "committed";
  const apply = () => patch.mutate({ id: u.id, data: { mapping } }, {
    onSuccess: () => toast({ title: "Mapping saved", description: "Preview refreshed. Still pending." }),
    onError: (e) => toast({ title: "Could not save mapping", description: e instanceof Error ? e.message : undefined, variant: "destructive" }),
  });
  const doCommit = () => commit.mutate(u.id, {
    onSuccess: (r) => toast({ title: u.kind === "price" ? "Price list stored" : "Program table committed. Open it in Programs to build a draft", description: `${r.rowCount.toLocaleString()} rows committed.` }),
    onError: (e) => toast({ title: "Commit failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" }),
  });
  return (
    <div className="space-y-3 rounded-md border bg-slate-50/60 p-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map((f) => (
          <label key={f.key} className="flex items-center gap-2 text-xs">
            <span className="w-24 shrink-0 text-slate-600">{f.label}{f.required && <span className="text-rose-600"> *</span>}</span>
            <Select value={mapping[f.key] || UNMAPPED} onValueChange={(v) => setMapping((m) => ({ ...m, [f.key]: v === UNMAPPED ? "" : v }))} disabled={committed}>
              <SelectTrigger className="h-8 text-xs" data-testid={`select-ref-map-${f.key}`}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={UNMAPPED}>Not mapped</SelectItem>
                {u.headers.filter(Boolean).map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {u.kind === "price"
          ? "Prices are reference values (RRP Inc, DD Cost Ex, T1 Buy Ex). Purchase cost is never used to calculate claims."
          : "Program tables open in Scanback Claims > Programs as a mapped preview. No promotion is created until you confirm the preview, then name, date and save the draft there."}
      </p>
      {u.kind === "program" && (
        <Button size="sm" variant="outline" asChild data-testid="link-open-program-preview">
          <Link href={`/scanback?programUpload=${encodeURIComponent(u.id)}&tab=programs`}><ExternalLink className="mr-1 h-3.5 w-3.5" /> {committed ? "Open in Programs" : "Preview in Programs"}</Link>
        </Button>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={reviewed} onCheckedChange={(v) => setReviewed(v === true)} disabled={committed} data-testid="checkbox-reviewed" />
          I have reviewed the preview rows and mapping
        </label>
        <div className="flex gap-2">
          {missing.length > 0 && <span className="self-center text-xs text-rose-700">Map {missing.map((f) => f.label).join(", ")}</span>}
          <Button size="sm" variant="outline" onClick={apply} disabled={!dirty || patch.isPending || committed} data-testid="button-apply-ref-mapping">
            <RefreshCw className="mr-1 h-3.5 w-3.5" /> {patch.isPending ? "Saving..." : "Apply mapping"}
          </Button>
          <Button size="sm" onClick={doCommit} disabled={committed || dirty || !reviewed || missing.length > 0 || u.errors.length > 0 || commit.isPending} data-testid="button-commit-ref">
            <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> {commit.isPending ? "Committing..." : `Commit ${u.rowCount.toLocaleString()} rows`}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ReviewCard({
  review,
  onCommit,
  onDiscard,
}: {
  review: any;
  onCommit: (data: CommitData) => Promise<void>;
  onDiscard: () => void;
}) {
  const [mappings, setMappings] = useState<any[]>(review.mappings || []);
  const [resellerId, setResellerId] = useState<number | null>(review.detected_reseller_id ?? null);
  const [weekIso, setWeekIso] = useState<string>(review.detected_week_iso ?? "");
  const [rememberPattern, setRememberPattern] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);

  const { data: allResellers } = useGetResellers();

  const updateMapping = (sourceCol: string, canonicalField: string) => {
    setMappings(prev => prev.map(m =>
      m.source_col === sourceCol
        ? { ...m, canonical_field: canonicalField === "ignore" ? null : canonicalField }
        : m
    ));
  };

  const weekNotDetected = !!review.week_not_detected;
  const hasSoldColumn = mappings.some(m => m.canonical_field === "sell_through_7d");
  const readyToCommit =
    !!resellerId &&
    !!weekIso &&
    validWeek(weekIso) &&
    mappings.some(m => m.canonical_field === "part_no") &&
    mappings.some(m => m.canonical_field === "soh") &&
    new Set(mappings.map(m => m.canonical_field).filter(Boolean)).size ===
      mappings.filter(m => m.canonical_field).length;

  return (
    <Card id={`review-${review.upload_id}`} className="border-amber-200 dark:border-amber-900 shadow-sm overflow-hidden scroll-mt-4">
      <CardHeader className="bg-amber-50 dark:bg-amber-950/20 pb-4">
        <div className="flex justify-between items-start gap-4 flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Badge className="bg-amber-500 hover:bg-amber-600 text-white flex-shrink-0">{review.diagnostics?.ready_to_commit ? "Ready to commit" : "Needs Review"}</Badge>
              <CardTitle className="text-lg flex items-center gap-2 truncate">
                <FileText className="h-5 w-5 text-amber-600 flex-shrink-0" />
                <span className="truncate">{review.filename}</span>
              </CardTitle>
            </div>
            <CardDescription className="text-amber-700 dark:text-amber-400">
              Pending only—not included in analytics until committed. Verify reseller, reporting week and column mappings.
            </CardDescription>
            {review.detection_reasoning && <p className="mt-2 text-xs text-muted-foreground">{review.detection_reasoning}</p>}
            <UploadDiagnostics diagnostics={review.diagnostics} />
            {!review.detected_reseller_id && review.candidates?.length > 0 && (
              <p className="mt-2 text-sm text-amber-800">
                Possible resellers: {review.candidates.map((c: any) => c.name).join(", ")}. Select the correct one.
              </p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              {review.rows_parsed ?? 0} product rows · {review.rows_flagged ?? 0} flagged for checking
            </p>
            {review.rows_flagged > 0 && (
              <p className="mt-1 text-sm text-amber-800">Check the source for unusual SKUs, invalid numbers or negative stock. Valid negative stock is preserved; invalid numbers must be corrected.</p>
            )}
          </div>

          {/* Editable metadata */}
          <div className="flex gap-3 flex-wrap">
            {/* Reseller picker */}
            <div className="min-w-[180px]">
              <p className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground mb-1">Reseller</p>
              <Select
                value={resellerId ? String(resellerId) : ""}
                onValueChange={(v) => setResellerId(v ? Number(v) : null)}
              >
                <SelectTrigger className={`h-8 text-sm ${!resellerId ? "border-amber-400" : ""}`}>
                  <SelectValue placeholder="Select reseller…" />
                </SelectTrigger>
                <SelectContent>
                  {(allResellers ?? []).map((r: any) => (
                    <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Week picker */}
            <div className="min-w-[140px]">
              <p className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground mb-1">
                Week {weekNotDetected && <span className="text-amber-600 font-semibold">⚠ not detected</span>}
              </p>
              <Input
                className={`h-8 text-sm font-mono ${weekNotDetected && !weekIso ? "border-amber-400" : ""}`}
                placeholder="2026-W27"
                value={weekIso}
                onChange={(e) => setWeekIso(e.target.value.trim())}
              />
              {weekIso && !validWeek(weekIso) && <p className="text-xs text-destructive mt-1">Enter a valid ISO week.</p>}
              {weekIso && validWeek(weekIso) && <p className="text-xs text-muted-foreground mt-1">{formatWeekLabel(weekIso)} (Mon–Sun)</p>}
              {review.detected_week_iso && weekIso !== review.detected_week_iso && (
                <p className="text-xs text-amber-700 mt-1 max-w-[200px]">
                  You are overriding {formatWeekLabel(review.detected_week_iso)}. Check the reporting period before committing.
                </p>
              )}
            </div>
          </div>
        </div>

        {weekNotDetected && (
          <div className="mt-3 flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400 bg-amber-100/60 dark:bg-amber-900/30 rounded-md px-3 py-2">
            <TriangleAlert className="h-4 w-4 flex-shrink-0" />
            Week could not be detected from the filename or report dates — please confirm the correct ISO week above before committing.
          </div>
        )}
      </CardHeader>

      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-1/3">Source Column</TableHead>
                <TableHead className="w-1/3">Map To Standard Field</TableHead>
                <TableHead>Preview (First row)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {mappings.map((mapping: any, idx: number) => {
                const previewValue =
                  review.preview_rows?.length > 0
                    ? review.preview_rows[0][mapping.source_col]
                    : mapping.sample_values?.[0] || "—";
                return (
                  <TableRow key={idx}>
                    <TableCell className="font-medium bg-muted/20">{mapping.source_col}</TableCell>
                    <TableCell>
                      <Select
                        value={mapping.canonical_field || "ignore"}
                        onValueChange={(val) => updateMapping(mapping.source_col, val)}
                      >
                        <SelectTrigger className={mapping.canonical_field ? "border-primary/50 bg-primary/5" : ""}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CANONICAL_FIELDS.map(f => (
                            <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="text-muted-foreground font-mono text-xs">
                      {String(previewValue ?? "—")}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>

      <CardFooter className="bg-muted/20 p-4 border-t flex flex-col gap-3">
        {/* Remember pattern */}
        {resellerId && (
          <div className="flex items-center gap-2 w-full">
            <Checkbox
              id={`remember-${review.upload_id}`}
              checked={rememberPattern}
              onCheckedChange={(v) => setRememberPattern(!!v)}
            />
            <Label htmlFor={`remember-${review.upload_id}`} className="text-sm text-muted-foreground cursor-pointer">
              Remember this filename pattern for{" "}
              <span className="font-medium text-foreground">
                {allResellers?.find((r: any) => r.id === resellerId)?.name ?? "this reseller"}
              </span>
            </Label>
          </div>
        )}

        <div className="flex justify-between items-center w-full">
          <Button variant="ghost" className="text-rose-600 hover:text-rose-700 hover:bg-rose-50" onClick={onDiscard}>
            Discard File
          </Button>
          <div className="flex items-center gap-3">
            {!readyToCommit && (
              <span className="text-sm text-amber-600">
                {!resellerId ? "Select a reseller" : !weekIso ? "Enter a week (e.g. 2026-W27)" : "Map Part No and SOH once each"}
              </span>
            )}
            {readyToCommit && !hasSoldColumn && (
              <span className="text-sm text-sky-700" data-testid="text-no-sold-column">
                No sold column — weekly serial reports will supply sell-through when available.
              </span>
            )}
            <Button
              disabled={!readyToCommit || isCommitting}
              onClick={async () => {
                setIsCommitting(true);
                try { await onCommit({ mappings, resellerId, weekIso, rememberPattern }); }
                finally { setIsCommitting(false); }
              }}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              {isCommitting ? "Committing…" : "Confirm & Commit"}
            </Button>
          </div>
        </div>
      </CardFooter>
    </Card>
  );
}
