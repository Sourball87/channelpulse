import { useEffect, useMemo, useRef, useState } from "react";
import { usePreviewProgramTable, type ProgramTablePreviewInput, type Reseller } from "@workspace/api-client-react";
import { AlertTriangle, CheckCircle2, ClipboardPaste, RefreshCw, Sparkles } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { customerLabel } from "@/lib/customer-display";
import { cn } from "@/lib/utils";
import { errorMessage } from "./shared";
import {
  PREVIEW_FIELDS, draftFromPreview, money,
  type PreviewMapping, type ProgramDraft, type ProgramTablePreview,
} from "@/lib/program-draft";

const UNMAPPED = "__unmapped";
const IGNORE = "__ignore";

function roleOf(m: PreviewMapping, h: string): string {
  const f = Object.entries(m.fields).find(([, v]) => v === h);
  if (f) return `f:${f[0]}`;
  if (m.ignored.includes(h)) return IGNORE;
  const c = m.customers[h];
  if (c != null) return `c:${c}`;
  return UNMAPPED;
}

function setRole(m: PreviewMapping, h: string, role: string): PreviewMapping {
  const fields = Object.fromEntries(Object.entries(m.fields).filter(([, v]) => v !== h));
  const customers = { ...m.customers }; delete customers[h];
  const ignored = m.ignored.filter((x) => x !== h);
  if (role.startsWith("f:")) fields[role.slice(2)] = h;
  else if (role.startsWith("c:")) customers[h] = Number(role.slice(2));
  else if (role === IGNORE) ignored.push(h);
  else customers[h] = null;
  return { fields, customers, ignored };
}

export function ProgramPasteDialog({
  open, onOpenChange, uploadId, resellers, onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  uploadId: string | null;
  resellers: Reseller[];
  onConfirm: (d: ProgramDraft) => void;
}) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<ProgramTablePreview | null>(null);
  const [mapping, setMapping] = useState<PreviewMapping | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewMut = usePreviewProgramTable();
  const ranFor = useRef<string | null>(null);
  const resById = new Map(resellers.map((r) => [r.id, r]));

  const run = async (opts: { mapping?: PreviewMapping }) => {
    setBusy(true); setError(null); setReviewed(false);
    try {
      const src = uploadId ? { uploadId } : { text };
      const data = (opts.mapping ? { ...src, mapping: opts.mapping, ai_assist: false } : { ...src, ai_assist: true }) as ProgramTablePreviewInput;
      const r = (await previewMut.mutateAsync({ data })) as unknown as ProgramTablePreview;
      setPreview(r); setMapping(r.mapping);
    } catch (e) {
      setError(errorMessage(e));
    } finally { setBusy(false); }
  };
  const runRef = useRef(run); runRef.current = run;

  useEffect(() => {
    if (!open) { ranFor.current = null; return; }
    if (uploadId && ranFor.current !== uploadId) {
      ranFor.current = uploadId;
      setPreview(null); setMapping(null); setText("");
      void runRef.current({});
    }
  }, [open, uploadId]);

  const reset = () => { setPreview(null); setMapping(null); setReviewed(false); setError(null); };
  const mappingDirty = !!preview && !!mapping && JSON.stringify(mapping) !== JSON.stringify(preview.mapping);
  const blocking = preview?.issues.filter((i) => i.blocking) ?? [];
  const issueRows = useMemo(() => new Map((preview?.issues ?? []).filter((i) => i.row != null).map((i) => [i.row as number, i])), [preview]);
  const issueCols = useMemo(() => new Set((preview?.issues ?? []).map((i) => i.column).filter(Boolean)), [preview]);
  const unresolved = preview && mapping ? preview.headers.filter((h) => h && roleOf(mapping, h) === UNMAPPED) : [];
  const canConfirm = !!preview && !mappingDirty && blocking.length === 0 && unresolved.length === 0 && reviewed && preview.rows.length > 0 && !busy;

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <DialogContent className="max-h-[92dvh] max-w-6xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ClipboardPaste className="h-5 w-5 text-cyan-700" /> {uploadId ? "Program table from Upload Center" : "Paste program"}</DialogTitle>
          <DialogDescription>
            Paste straight from Excel or an email. Columns are mapped, customers matched, and you review everything before a draft is built.
            Nothing is saved until you click Save changes on the program table. Prices and caps come only from the source.
          </DialogDescription>
        </DialogHeader>

        {!uploadId && !preview && (
          <div className="space-y-2">
            <Textarea rows={10} className="font-mono text-xs" placeholder={"SKU\tRRP Inc\tGTM Inc\tDiscount\tDD Cost Ex\tT1 Ex\tGTM Buy Ex\tCA\tCentrecom\tScorptec\tPLE"}
              value={text} onChange={(e) => setText(e.target.value)} data-testid="input-paste-program" />
            <div className="flex justify-end">
              <Button size="sm" onClick={() => run({})} disabled={!text.trim() || busy} data-testid="button-parse-paste">
                <Sparkles className="mr-1 h-3.5 w-3.5" /> {busy ? "Reading..." : "Read table"}
              </Button>
            </div>
          </div>
        )}

        {busy && !preview && <div className="space-y-2"><Skeleton className="h-16 w-full" /><Skeleton className="h-40 w-full" /></div>}
        {error && (
          <div className="flex items-center justify-between gap-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700" data-testid="text-paste-error">
            <span>{error}</span>
            <Button size="sm" variant="outline" className="h-7" onClick={() => run(mapping && preview ? { mapping } : {})} data-testid="button-retry-preview">Retry</Button>
          </div>
        )}

        {preview && mapping && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
              <span className="font-mono" data-testid="text-preview-source">{preview.sourceName} &middot; {preview.rows.length} rows &middot; {preview.customerIds.length} customers</span>
              {!uploadId && <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={reset} data-testid="button-paste-again">Paste different table</Button>}
            </div>
            {preview.aiNote && <p className="rounded-md bg-violet-50 px-3 py-1.5 text-xs text-violet-800" data-testid="text-ai-note"><Sparkles className="mr-1 inline h-3 w-3" />{preview.aiNote}</p>}

            <div className="rounded-md border">
              <div className="flex items-center justify-between border-b bg-slate-50 px-3 py-1.5">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Column mapping</span>
                <Button size="sm" variant="outline" className="h-7" disabled={!mappingDirty || busy} onClick={() => run({ mapping })} data-testid="button-apply-paste-mapping">
                  <RefreshCw className="mr-1 h-3.5 w-3.5" /> {busy ? "Applying..." : "Apply mapping"}
                </Button>
              </div>
              <div className="grid gap-1.5 p-2 sm:grid-cols-2 lg:grid-cols-4">
                {preview.headers.filter(Boolean).map((h, k) => {
                  const role = roleOf(mapping, h);
                  return (
                    <label key={h} className={cn("flex items-center gap-2 rounded px-1.5 py-1 text-xs", (role === UNMAPPED || issueCols.has(h)) && "bg-amber-50 ring-1 ring-amber-300")}>
                      <span className="w-24 shrink-0 truncate font-mono text-slate-700" title={h}>{h}</span>
                      <Select value={role} onValueChange={(v) => setMapping(setRole(mapping, h, v))}>
                        <SelectTrigger className="h-7 text-xs" data-testid={`select-paste-map-${k}`}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value={UNMAPPED}>Unmatched - choose</SelectItem>
                          <SelectItem value={IGNORE}>Ignore column</SelectItem>
                          {PREVIEW_FIELDS.map((f) => <SelectItem key={f.key} value={`f:${f.key}`}>{f.label}</SelectItem>)}
                          {resellers.map((r) => <SelectItem key={r.id} value={`c:${r.id}`}>Cap: {customerLabel(r.code)}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </label>
                  );
                })}
              </div>
              {mappingDirty && <p className="border-t px-3 py-1.5 text-[11px] text-amber-800">Mapping changed. Apply mapping to refresh the preview before confirming.</p>}
            </div>

            {preview.issues.length > 0 && (
              <div className="max-h-32 overflow-y-auto rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs" data-testid="list-preview-issues">
                {preview.issues.map((i, k) => (
                  <p key={k} className={i.blocking ? "text-rose-700" : "text-amber-800"}>
                    <AlertTriangle className="mr-1 inline h-3 w-3" />
                    {i.row != null ? `Row ${i.row}` : "Column"}{i.column ? ` \u00b7 ${i.column}` : ""}: {i.message}{i.blocking ? "" : " (complete in the draft)"}
                  </p>
                ))}
              </div>
            )}

            <div className="max-h-[38dvh] overflow-auto rounded-md border">
              <table className="w-full border-collapse text-[11px]">
                <thead className="sticky top-0 bg-slate-100">
                  <tr>
                    {["Row", "SKU", "RRP Inc", "GTM Inc", "DD Cost Ex", "T1 Ex", "GTM Buy Ex"].map((h) => <th key={h} className="border-r px-1.5 py-1 text-right font-medium text-slate-500 first:text-left">{h}</th>)}
                    {preview.customerIds.map((id) => <th key={id} className="border-r bg-cyan-50 px-1.5 py-1 text-right font-medium text-cyan-900">{customerLabel(resById.get(id)?.code ?? id)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => {
                    const issue = issueRows.get(r.sourceRow);
                    return (
                      <tr key={r.sourceRow} className={cn("border-t font-mono tabular-nums", issue && (issue.blocking ? "bg-rose-50" : "bg-amber-50/70"))} title={issue?.message} data-testid={`row-preview-${r.sourceRow}`}>
                        <td className="border-r px-1.5 py-0.5 text-slate-400">{r.sourceRow}</td>
                        <td className="border-r px-1.5 py-0.5 text-right">{r.sku}</td>
                        <td className="border-r px-1.5 py-0.5 text-right">{money(r.rrpIncCents)}</td>
                        <td className="border-r px-1.5 py-0.5 text-right">{money(r.gtmIncCents)}</td>
                        <td className="border-r px-1.5 py-0.5 text-right">{money(r.ddCostExCents)}</td>
                        <td className="border-r px-1.5 py-0.5 text-right">{money(r.t1ExCents)}</td>
                        <td className={cn("border-r px-1.5 py-0.5 text-right font-semibold", r.gtmBuyCents == null && "bg-amber-100/70")}>{money(r.gtmBuyCents)}</td>
                        {preview.customerIds.map((id) => {
                          const q = r.caps.find((c) => c.resellerId === id)?.quantity;
                          return <td key={id} className="border-r px-1.5 py-0.5 text-right">{q == null ? "" : q}</td>;
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={reviewed} onCheckedChange={(v) => setReviewed(v === true)} disabled={mappingDirty} data-testid="checkbox-confirm-preview" />
              I have reviewed the headings, customer matches and preview rows
            </label>
          </div>
        )}

        <DialogFooter className="items-center gap-2">
          {preview && (blocking.length > 0 || unresolved.length > 0) && (
            <span className="mr-auto text-xs text-rose-700">
              {unresolved.length > 0 ? `Map or ignore: ${unresolved.join(", ")}. ` : ""}{blocking.length > 0 ? `${blocking.length} blocking issue(s).` : ""}
            </span>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-paste">Cancel</Button>
          <Button disabled={!canConfirm} data-testid="button-confirm-paste"
            onClick={() => { if (preview) { onConfirm(draftFromPreview(preview)); onOpenChange(false); reset(); } }}>
            <CheckCircle2 className="mr-1 h-4 w-4" /> Build draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
