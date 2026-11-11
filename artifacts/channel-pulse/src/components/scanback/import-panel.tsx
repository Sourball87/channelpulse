import { Fragment } from "react";
import { customerLabel, maskCustomerText } from "@/lib/customer-display";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  useCommitScanbackImport,
  useRemapScanbackImport,
  useSupersedeScanbackImport,
  type Reseller,
  type ScanbackImport,
  type ScanbackMappingDateFormat,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FileSpreadsheet, RefreshCw, CheckCircle2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { FIELD_LABEL, KIND_META, MAPPING_KEYS, type MappingKey } from "./import-config";
import { SectionEmpty, errorMessage, formatCents, formatDateTime, useRefreshWorkspace } from "./shared";
import { ProntoAccounts } from "./pronto-accounts";

const NONE = "__none";
const isSameCustomerRepeat = (reason?: string) => reason?.startsWith("Also in earlier report ") ?? false;

export function ImportPanel({
  imports,
  resellers,
  selectedId,
  onCommitted,
}: {
  imports: ScanbackImport[];
  resellers: Reseller[];
  /** Scanback import UUID to open for mapping review (from the Upload Center). */
  selectedId?: string | null;
  onCommitted?: (imp: ScanbackImport) => void;
}) {
  const { toast } = useToast();
  const refresh = useRefreshWorkspace();
  const [current, setCurrent] = useState<ScanbackImport | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [dateFormat, setDateFormat] = useState<ScanbackMappingDateFormat>("dmy");
  const [sheet, setSheet] = useState("");
  const [accountId, setAccountId] = useState<number | null>(null);
  const [prontoAccounts, setProntoAccounts] = useState<Record<string, number | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [supersedeOpen, setSupersedeOpen] = useState(false);
  const remap = useRemapScanbackImport();
  const commit = useCommitScanbackImport();
  const supersede = useSupersedeScanbackImport();
  const resById = new Map(resellers.map((r) => [r.id, r]));

  const load = (imp: ScanbackImport) => {
    setCurrent(imp);
    setMapping(Object.fromEntries(MAPPING_KEYS.map((k) => [k, imp.mapping[k] ?? ""])));
    setDateFormat(imp.dateFormat);
    setSheet(imp.sheet);
    setAccountId(imp.accountId);
    setProntoAccounts(imp.prontoAccounts ?? {});
  };

  const applyMapping = (imp: ScanbackImport | null = current) => {
    if (!imp) return;
    setError(null);
    remap.mutate(
      { id: imp.id, data: { mapping: Object.fromEntries(MAPPING_KEYS.map((k) => [k, mapping[k] ?? ""])), dateFormat, sheet, accountId, prontoAccounts } },
      { onSuccess: (r) => { load(r); refresh(); }, onError: (e) => setError(errorMessage(e)) },
    );
  };

  const loadSamples = (imp: ScanbackImport) => {
    setError(null);
    remap.mutate(
      { id: imp.id, data: { mapping: imp.mapping, dateFormat: imp.dateFormat, sheet: imp.sheet, accountId: imp.accountId, prontoAccounts: imp.prontoAccounts } },
      { onSuccess: (r) => load(r), onError: (e) => setError(errorMessage(e)) },
    );
  };

  const doCommit = () => {
    if (!current) return;
    commit.mutate(
      { id: current.id },
      {
        onSuccess: (r) => { load({ ...r, rows: r.rows.length ? r.rows : current.rows }); refresh(); toast({ title: "Import committed", description: `${r.recordCount} records saved.` }); onCommitted?.(r); },
        onError: (e) => setError(errorMessage(e)),
      },
    );
  };
  const doSupersede = () => {
    if (!current) return;
    supersede.mutate({ id: current.id }, {
      onSuccess: r => {
        load(r); setSupersedeOpen(false); refresh();
        toast({ title: "Report superseded", description: "Its serials no longer contribute to active report ownership or sales counts. Approved claims remain blocked." });
      },
      onError: e => { setSupersedeOpen(false); setError(errorMessage(e)); },
    });
  };

  const meta = KIND_META[current?.kind ?? "claim"];
  const missing = useMemo(() => {
    if (!current) return [] as MappingKey[];
    const m = KIND_META[current.kind];
    const miss = m.required.filter((k) => !mapping[k]);
    if (m.needsAccount && !mapping.account && accountId == null) miss.push("account");
    return miss;
  }, [current, mapping, accountId]);
  const dirty = current
    ? MAPPING_KEYS.some((k) => (mapping[k] ?? "") !== (current.mapping[k] ?? "")) || dateFormat !== current.dateFormat || sheet !== current.sheet || accountId !== current.accountId ||
      JSON.stringify(Object.entries(prontoAccounts).sort()) !== JSON.stringify(Object.entries(current.prontoAccounts ?? {}).sort())
    : false;
  const unmatchedCreditCount = current?.pronto?.excludedCounts["Unmatched credit — no serial number"] ?? 0;
  const canCommit = current && current.state === "preview" && !current.duplicate && current.errors.length === 0 && missing.length === 0 && !dirty &&
    (current.recordCount > 0 || unmatchedCreditCount > 0);
  const busy = remap.isPending || commit.isPending || supersede.isPending;
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId || opened.current === selectedId) return;
    const imp = imports.find((i) => i.id === selectedId);
    if (!imp) return;
    opened.current = selectedId;
    loadSamples(imp);
  }, [selectedId, imports]); // eslint-disable-line react-hooks/exhaustive-deps
  const sorted = [...imports].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_340px]">
      <div className="space-y-4 min-w-0">
        {error && <div data-testid="text-import-error" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}

        {!current ? (
          <SectionEmpty title="No import open" body="Open a pending file from the list to review its mapping and sample rows. New files come in through the drop zone above." />
        ) : (
          <div className="rounded-lg border bg-background">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
              <div className="min-w-0">
                <p className="truncate font-medium" data-testid="text-import-name">{current.name}</p>
                <p className="text-xs text-slate-500">{meta.label} &middot; {current.recordCount} records &middot; {formatDateTime(current.createdAt)}</p>
              </div>
              <div className="flex items-center gap-2">
                {current.duplicate && <Badge variant="destructive">Duplicate of earlier import</Badge>}
                <Badge variant={current.state === "committed" ? "default" : "secondary"} data-testid="status-import-state">
                  {current.state === "committed" ? "Committed" : current.state === "superseded" ? "Superseded" : "Preview"}
                </Badge>
              </div>
            </div>

            <div className="grid gap-3 p-4 md:grid-cols-3">
              <div className="space-y-1">
                <Label className="text-xs">Sheet</Label>
                 <Select value={sheet} onValueChange={setSheet} disabled={current.state !== "preview"}>
                  <SelectTrigger data-testid="select-import-sheet"><SelectValue placeholder="Sheet" /></SelectTrigger>
                  <SelectContent>{current.sheets.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Date format</Label>
                 <Select value={dateFormat} onValueChange={(v) => setDateFormat(v as ScanbackMappingDateFormat)} disabled={current.state !== "preview"}>
                  <SelectTrigger data-testid="select-import-date-format"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="dmy">Day / month / year</SelectItem>
                    <SelectItem value="mdy">Month / day / year</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Fallback account</Label>
                 <Select value={accountId == null ? NONE : String(accountId)} onValueChange={(v) => setAccountId(v === NONE ? null : Number(v))} disabled={current.state !== "preview" || !!current.pronto}>
                  <SelectTrigger data-testid="select-import-account"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>None - use account column</SelectItem>
                    {resellers.map((r) => <SelectItem key={r.id} value={String(r.id)}>{customerLabel(r.code)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-x-4 gap-y-2 border-t px-4 py-4 md:grid-cols-2">
              {MAPPING_KEYS.map((k) => {
                const req = meta.required.includes(k) || (k === "account" && meta.needsAccount && accountId == null);
                return (
                  <div key={k} className="flex items-center gap-2">
                    <span className={`w-1/2 text-xs ${k === "unitPrice" ? "font-semibold text-cyan-800" : "text-slate-600"}`}>
                      {FIELD_LABEL[k]}{req && <span className="text-rose-600"> *</span>}
                    </span>
                    <Select value={mapping[k] || NONE} onValueChange={(v) => setMapping((m) => ({ ...m, [k]: v === NONE ? "" : v }))} disabled={current.state !== "preview" || !!current.pronto}>
                      <SelectTrigger className="h-8 w-1/2 text-xs" data-testid={`select-map-${k}`}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>Not mapped</SelectItem>
                        {current.headers.filter((h) => h !== "").map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            </div>

            {current.pronto && <ProntoAccounts key={current.id + current.sheet} preview={current.pronto} values={prontoAccounts}
              onChange={setProntoAccounts} resellers={resellers} disabled={busy || current.state !== "preview"} />}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-slate-50/60 px-4 py-3">
              <p className="text-xs text-slate-600">
                {missing.length > 0 ? <span className="text-rose-700">Missing: {missing.map((k) => FIELD_LABEL[k]).join(", ")}</span>
                  : dirty ? "Mapping changed - apply to refresh the preview." :
                    current.state === "committed" ? "Already committed. It will not be recommitted." :
                    current.state === "superseded" ? "Superseded report. It no longer counts toward active sales." : "Review samples and issues, then commit."}
              </p>
              <div className="flex gap-2">
                {current.kind === "claim" && current.state === "committed" && <Button variant="outline" size="sm" disabled={busy}
                  onClick={() => setSupersedeOpen(true)} data-testid="button-supersede-report">Mark superseded</Button>}
                <Button variant="outline" size="sm" disabled={busy || current.state !== "preview"} onClick={() => applyMapping()} data-testid="button-apply-mapping">
                  <RefreshCw className="mr-1 h-3.5 w-3.5" /> {remap.isPending ? "Applying..." : "Apply mapping"}
                </Button>
                <Button size="sm" disabled={!canCommit || busy} onClick={doCommit} data-testid="button-commit-import">
                  <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> {commit.isPending ? "Committing..." :
                    current.recordCount ? `Commit ${current.recordCount} records` : "Commit unmatched credits"}
                </Button>
              </div>
            </div>

            {(current.errors.length > 0 || current.warnings.length > 0) && (
              <div className="max-h-48 space-y-1 overflow-y-auto border-t px-4 py-3 text-xs">
                {current.errors.map((e, i) => <p key={`e${i}`} className="text-rose-700" data-testid={`text-import-issue-${i}`}>Row {e.row}: {e.message}</p>)}
                {current.warnings.map((w, i) => <p key={`w${i}`} className="text-amber-700" data-testid={`text-import-warning-${i}`}>{w}</p>)}
              </div>
            )}

            {current.rows.some((r) => r.reuseReason) && <p className="border-t px-4 py-2 text-xs" data-testid="text-import-reuse-summary">
              {current.rows.filter(r => isSameCustomerRepeat(r.reuseReason)).length > 0 &&
                <span className="text-amber-800">{current.rows.filter(r => isSameCustomerRepeat(r.reuseReason)).length} row(s) also appear in an earlier report for this customer. They are amber and can still be verified unless approved. </span>}
              {current.rows.filter(r => r.reuseReason && !isSameCustomerRepeat(r.reuseReason)).length > 0 &&
                <span className="text-rose-800">{current.rows.filter(r => r.reuseReason && !isSameCustomerRepeat(r.reuseReason)).length} row(s) are red because they were approved, sold by another customer or duplicated.</span>}
            </p>}
            <div className="border-t">
              {current.rows.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-slate-500">
                  {unmatchedCreditCount ? "No serial rows. Unmatched credits are listed in the Pronto exclusions above." : "No sample rows loaded. Apply the mapping to retrieve samples."}
                </p>
              ) : (
                <div className="max-h-[420px] overflow-auto">
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead>Source row</TableHead><TableHead>Serial</TableHead><TableHead>SKU</TableHead><TableHead>Date</TableHead><TableHead>Account</TableHead>
                      <TableHead className="text-right">Qty</TableHead><TableHead>Invoice</TableHead><TableHead className="text-right">Inv. unit ex GST</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Program / ref</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {current.rows.slice(0, 50).map((r) => (<Fragment key={r.rowIndex}>
                        <TableRow className={`font-mono text-xs ${r.reuseReason ? isSameCustomerRepeat(r.reuseReason) ? "bg-amber-50/70" : "bg-rose-50/60" : ""}`} data-testid={`row-import-${r.rowIndex}`}>
                          <TableCell>{r.sourceRow ?? r.rowIndex + 2}</TableCell><TableCell>{r.serial}</TableCell><TableCell>{r.sku}</TableCell><TableCell>{r.date}</TableCell>
                          <TableCell>{r.accountId == null ? "-" : customerLabel(resById.get(r.accountId)?.code ?? r.accountId)}</TableCell>
                          <TableCell className="text-right">{r.quantity}</TableCell><TableCell>{r.invoice}</TableCell>
                          <TableCell className="text-right">{r.unitPriceCents == null ? "-" : formatCents(r.unitPriceCents)}</TableCell>
                          <TableCell className="text-right">{r.amountCents == null ? "-" : formatCents(r.amountCents)}</TableCell>
                          <TableCell>{[r.program, r.reference].filter(Boolean).join(" / ")}{r.costCents != null && <span className="block text-[10px] text-slate-500">Our cost (reference only): {formatCents(r.costCents)}</span>}</TableCell>
                        </TableRow>
                        {r.reuseReason && (
                          <TableRow className={isSameCustomerRepeat(r.reuseReason) ? "bg-amber-50/70" : "bg-rose-50/60"}><TableCell colSpan={10} className={`py-1 text-[11px] ${isSameCustomerRepeat(r.reuseReason) ? "text-amber-800" : "text-rose-800"}`} data-testid={`text-import-reuse-${r.rowIndex}`}>
                            {isSameCustomerRepeat(r.reuseReason) ? "Also reported (still verifiable): " : "Repeated serial (not counted): "}{maskCustomerText(r.reuseReason)}
                          </TableCell></TableRow>
                        )}
                      </Fragment>))}
                    </TableBody>
                  </Table>
                  <p className="px-4 py-2 text-[11px] text-slate-500">Showing {Math.min(50, current.rows.length)} of {current.recordCount} records.</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <aside className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Saved imports</h3>
        {sorted.length === 0 && <p className="text-sm text-slate-500">None yet.</p>}
        {sorted.map((imp) => (
          <button
            key={imp.id}
            type="button"
            data-testid={`button-open-import-${imp.id}`}
            onClick={() => loadSamples(imp)}
            disabled={busy}
            className={`w-full rounded-md border px-3 py-2 text-left transition-colors hover:bg-cyan-50/60 ${current?.id === imp.id ? "border-cyan-500 bg-cyan-50/50" : "bg-background"}`}
          >
            <div className="flex items-center gap-2">
              <FileSpreadsheet className="h-4 w-4 shrink-0 text-cyan-700" />
              <span className="truncate text-sm font-medium">{imp.name}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-slate-500">
              <span>{KIND_META[imp.kind].label}</span><span>&middot; {imp.recordCount} rows</span>
              <span className={imp.state === "committed" ? "text-emerald-700" : imp.state === "superseded" ? "text-slate-500" : "text-amber-700"}>&middot; {imp.state}</span>
              {imp.errors.length > 0 && <span className="text-rose-700">&middot; {imp.errors.length} errors</span>}
            </div>
          </button>
        ))}
      </aside>
      <AlertDialog open={supersedeOpen} onOpenChange={setSupersedeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark this report as superseded?</AlertDialogTitle>
            <AlertDialogDescription>
              This report will stop contributing serial ownership and sales counts. Its source remains in the audit trail, and any approved claim stays permanently blocked.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={supersede.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={supersede.isPending} onClick={e => { e.preventDefault(); doSupersede(); }}>
              {supersede.isPending ? "Marking..." : "Mark superseded"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
