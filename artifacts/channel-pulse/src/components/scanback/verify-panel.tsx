import { customerLabel } from "@/lib/customer-display";
import { useEffect, useMemo, useState } from "react";
import {
  getExportScanbackBatchUrl,
  getExportScanbackDraftUrl,
  useApproveScanbackClaim,
  useVerifyScanbackClaim,
  type Reseller,
  type ScanbackBatch,
  type ScanbackDraft,
  type ScanbackImport,
  type ScanbackProgram,
  type ScanbackVerificationInputBasis,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CheckCircle2, Download, RefreshCw, ShieldCheck } from "lucide-react";
import { SectionEmpty, StatusPill, errorMessage, formatCents, formatDate, formatDateTime, useRefreshWorkspace } from "./shared";

export function VerifyPanel({
  programs, imports, drafts, resellers, onApproved,
}: {
  programs: ScanbackProgram[]; imports: ScanbackImport[]; drafts: ScanbackDraft[]; resellers: Reseller[];
  onApproved: (b: ScanbackBatch) => void;
}) {
  const refresh = useRefreshWorkspace();
  const verify = useVerifyScanbackClaim();
  const approve = useApproveScanbackClaim();
  const [programId, setProgramId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [claimImportId, setClaimImportId] = useState("");
  const [basis, setBasis] = useState<ScanbackVerificationInputBasis>("sell");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [draft, setDraft] = useState<ScanbackDraft | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reference, setReference] = useState("");
  const [approved, setApproved] = useState<ScanbackBatch | null>(null);

  const program = programs.find((p) => p.id === programId);
  const activePrograms = programs.filter((p) => !p.archived);
  const claimImports = imports.filter((i) => i.kind === "claim" && i.state === "committed");
  const resById = new Map(resellers.map((r) => [r.id, r]));
  const accounts = program ? resellers.filter((r) => program.customerIds.includes(r.id)) : [];

  useEffect(() => {
    if (program && !draft) { setFrom(program.start.slice(0, 10)); setTo(program.end.slice(0, 10)); }
  }, [programId]); // eslint-disable-line react-hooks/exhaustive-deps

  const showDraft = (d: ScanbackDraft) => {
    setDraft(d);
    setSelected(new Set(d.results.filter((r) => r.include && r.selectable).map((r) => r.rowIndex)));
  };

  const restore = (d: ScanbackDraft) => {
    setError(null); setApproved(null);
    setProgramId(d.settings.programId); setAccountId(String(d.settings.accountId));
    setClaimImportId(d.settings.claimImportId); setBasis(d.settings.basis);
    setFrom(d.settings.from.slice(0, 10)); setTo(d.settings.to.slice(0, 10));
    showDraft(d);
  };

  const settingsDirty = !!draft && (
    draft.settings.programId !== programId || String(draft.settings.accountId) !== accountId ||
    draft.settings.claimImportId !== claimImportId || draft.settings.basis !== basis ||
    draft.settings.from.slice(0, 10) !== from || draft.settings.to.slice(0, 10) !== to);
  const selectionDirty = useMemo(() => {
    if (!draft) return false;
    const inc = draft.results.filter((r) => r.include && r.selectable).map((r) => r.rowIndex);
    return inc.length !== selected.size || inc.some((i) => !selected.has(i));
  }, [draft, selected]);
  const dirty = settingsDirty || selectionDirty;

  const run = (withSelection: boolean) => {
    setError(null); setApproved(null);
    if (!programId || !accountId || !claimImportId || !from || !to) return setError("Choose a promotion, account, claim import and date range.");
    if (to < from) return setError("The 'to' date must be on or after the 'from' date.");
    verify.mutate(
      { data: {
        programId, accountId: Number(accountId), claimImportId, basis, from, to,
        ...(withSelection && draft && !settingsDirty ? { draftId: draft.id, selectedRows: [...selected].sort((a, b) => a - b) } : {}),
      } },
      { onSuccess: (d) => { showDraft(d); refresh(); }, onError: (e) => setError(errorMessage(e)) },
    );
  };

  const doApprove = () => {
    if (!draft || approve.isPending) return;
    approve.mutate(
      { data: { draftId: draft.id, token: draft.token, reference: reference.trim() } },
      {
        onSuccess: (b) => { setConfirmOpen(false); setApproved(b); setDraft(null); setReference(""); refresh(); onApproved(b); },
        onError: (e) => { setConfirmOpen(false); setError(errorMessage(e)); },
      },
    );
  };

  const counts = draft ? {
    eligible: draft.results.filter((r) => r.status === "eligible").length,
    review: draft.results.filter((r) => r.status === "review").length,
    rejected: draft.results.filter((r) => r.status === "rejected").length,
  } : null;
  const recentDrafts = [...drafts].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8);
  const canApprove = !!draft && !dirty && draft.totalCents > 0 && !verify.isPending && !approve.isPending;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-background p-4">
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          <div className="space-y-1 xl:col-span-2">
            <Label className="text-xs">Promotion</Label>
            <Select value={programId} onValueChange={(v) => { setProgramId(v); setAccountId(""); }}>
              <SelectTrigger data-testid="select-verify-program"><SelectValue placeholder="Choose promotion" /></SelectTrigger>
              <SelectContent>{activePrograms.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Account</Label>
            <Select value={accountId} onValueChange={setAccountId} disabled={!program}>
              <SelectTrigger data-testid="select-verify-account"><SelectValue placeholder="Account" /></SelectTrigger>
              <SelectContent>{accounts.map((r) => <SelectItem key={r.id} value={String(r.id)}>{customerLabel(r.code)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1 xl:col-span-3">
            <Label className="text-xs">Committed claim import</Label>
            <Select value={claimImportId} onValueChange={setClaimImportId}>
              <SelectTrigger data-testid="select-verify-import"><SelectValue placeholder={claimImports.length ? "Choose claim file" : "Commit a claim import first"} /></SelectTrigger>
              <SelectContent>{claimImports.map((i) => <SelectItem key={i.id} value={i.id}>{i.name} ({i.recordCount})</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Date basis</Label>
            <Select value={basis} onValueChange={(v) => setBasis(v as ScanbackVerificationInputBasis)}>
              <SelectTrigger data-testid="select-verify-basis"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="sell">Customer sale date</SelectItem>
                <SelectItem value="invoice">Invoice date</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">From</Label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="input-verify-from" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">To</Label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} data-testid="input-verify-to" />
          </div>
          <div className="flex items-end xl:col-span-3">
            <Button onClick={() => run(false)} disabled={verify.isPending} data-testid="button-run-verify">
              <ShieldCheck className="mr-1.5 h-4 w-4" /> {verify.isPending ? "Verifying..." : "Verify claim"}
            </Button>
          </div>
        </div>
      </div>

      {error && <div data-testid="text-verify-error" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}

      {approved && (
        <div data-testid="card-approval-success" className="flex flex-wrap items-center gap-3 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3">
          <CheckCircle2 className="h-5 w-5 text-emerald-700" />
          <div className="flex-1 text-sm text-emerald-900">
            Claim decision <span className="font-semibold">{approved.reference}</span> approved: {approved.approvedCount} serials, {formatCents(approved.totalCents)}.
            No payment has been made; this records the claim decision only.
          </div>
          <Button size="sm" variant="outline" asChild><a href={getExportScanbackBatchUrl(approved.id, "xlsx")}>Statement (XLSX)</a></Button>
        </div>
      )}

      {!draft ? (
        <div className="space-y-3">
          <SectionEmpty title="No verification open" body="Run a verification, or restore a saved draft below. Results are not approved until you explicitly approve them." />
          {recentDrafts.length > 0 && (
            <div className="rounded-lg border bg-background">
              <p className="border-b px-4 py-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Saved drafts</p>
              {recentDrafts.map((d) => (
                <button key={d.id} type="button" onClick={() => restore(d)} data-testid={`button-restore-draft-${d.id}`}
                  className="flex w-full items-center justify-between gap-2 border-b px-4 py-2 text-left text-sm last:border-0 hover:bg-cyan-50/50">
                  <span>{programs.find((p) => p.id === d.settings.programId)?.name ?? "Promotion"} &middot; {customerLabel(resById.get(d.settings.accountId)?.code ?? d.settings.accountId)}</span>
                  <span className="font-mono text-xs text-slate-500">{formatCents(d.totalCents)} &middot; {formatDateTime(d.createdAt)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-lg border bg-background">
          <div className="flex flex-wrap items-center gap-4 border-b px-4 py-3">
            <div className="flex-1 min-w-[200px]">
              <p className="text-xs font-semibold uppercase tracking-wider text-amber-700">Draft - not approved</p>
              <p className="text-sm text-slate-600">
                Basis: {draft.settings.basis === "sell" ? "customer sale date" : "invoice date"}, {formatDate(draft.settings.from)} to {formatDate(draft.settings.to)}
                {counts && <> &middot; {counts.eligible} eligible, {counts.review} review, {counts.rejected} rejected</>}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs text-slate-500">Selected total</p>
              <p className="font-mono text-xl font-semibold tabular-nums" data-testid="text-draft-total">{formatCents(draft.totalCents)}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild data-testid="link-draft-export">
                <a href={getExportScanbackDraftUrl(draft.id)}><Download className="mr-1 h-3.5 w-3.5" /> Draft statement</a>
              </Button>
              <Button variant="outline" size="sm" onClick={() => run(true)} disabled={verify.isPending || !dirty} data-testid="button-recheck">
                <RefreshCw className="mr-1 h-3.5 w-3.5" /> Recheck selection
              </Button>
              <Button size="sm" onClick={() => setConfirmOpen(true)} disabled={!canApprove} data-testid="button-approve">Approve claim</Button>
            </div>
          </div>
          {dirty && <p className="border-b bg-amber-50 px-4 py-2 text-xs text-amber-800">Selection or settings changed. Recheck before approving{settingsDirty ? " (settings changed - this will run a fresh verification)" : ""}.</p>}
          <div className="max-h-[560px] overflow-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead className="w-8" /><TableHead>Status</TableHead><TableHead>Serial</TableHead><TableHead>SKU</TableHead><TableHead>Sale date</TableHead>
                <TableHead>Invoice</TableHead><TableHead className="text-right">Inv. unit ex GST</TableHead><TableHead className="text-right">GTM Buy Ex</TableHead>
                <TableHead className="text-right">Claim</TableHead><TableHead>Reason</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {draft.results.map((r) => (
                  <TableRow key={r.rowIndex} data-testid={`row-result-${r.rowIndex}`} className={r.status === "rejected" ? "bg-rose-50/30" : ""}>
                    <TableCell>
                      {r.selectable && (
                        <Checkbox checked={selected.has(r.rowIndex)} data-testid={`checkbox-result-${r.rowIndex}`}
                          onCheckedChange={(c) => setSelected((s) => { const n = new Set(s); if (c) n.add(r.rowIndex); else n.delete(r.rowIndex); return n; })} />
                      )}
                    </TableCell>
                    <TableCell><StatusPill status={r.status} /></TableCell>
                    <TableCell className="font-mono text-xs">{r.serial}{r.quantity !== 1 && <span className="ml-1 text-amber-700">x{r.quantity}</span>}</TableCell>
                    <TableCell className="font-mono text-xs">{r.sku}</TableCell>
                    <TableCell className="text-xs">{r.date || "-"}</TableCell>
                    <TableCell className="text-xs"><span className="font-mono">{r.invoice || "-"}</span>{r.invoiceDate && <span className="block text-slate-500">{r.invoiceDate}</span>}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{formatCents(r.unitPriceCents)}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{formatCents(r.gtmBuyCents)}</TableCell>
                    <TableCell className="text-right font-mono text-xs font-semibold">{formatCents(r.amountCents)}</TableCell>
                    <TableCell className="max-w-xs text-xs text-slate-600">{r.reason}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={(o) => !approve.isPending && setConfirmOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve {draft ? formatCents(draft.totalCents) : ""} claim?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently records the selected serials as claimed. Each serial can never be paid again under any promotion.
              Eligibility and caps are rechecked on the server. No bank transfer is made.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="sb-ref">Claim reference</Label>
            <Input id="sb-ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. SB-2025-031" data-testid="input-approve-reference" />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={approve.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={!reference.trim() || approve.isPending} data-testid="button-confirm-approve"
              onClick={(e) => { e.preventDefault(); doApprove(); }}>
              {approve.isPending ? "Approving..." : "Approve claim"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
