import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useDeleteScanbackProgram, useSaveScanbackProgram, type Part, type Reseller, type ScanbackProgram } from "@workspace/api-client-react";
import { Archive, ArchiveRestore, ClipboardPaste, Copy, ExternalLink, FileSpreadsheet, Plus, RotateCcw, Save, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { customerLabel } from "@/lib/customer-display";
import type { CenterUpload, PriceRow } from "@/lib/upload-center";
import {
  buildInput, draftFromProgram, emptyDraft, fingerprint, money, uniqueName,
  type ProgramDraft, type ProgramStat,
} from "@/lib/program-draft";
import { ProgramGrid, StatusChip } from "./program-grid";
import { ProgramPasteDialog } from "./program-paste";
import { errorMessage, formatDate, useRefreshWorkspace } from "./shared";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

const NEW = "__draft";

function statsFor(stats: ProgramStat[], programId: string | undefined) {
  const bySku = new Map<string, number>();
  const customers = new Set<number>();
  let count = 0, cents = 0;
  if (programId) for (const s of stats) {
    if (s.programId !== programId) continue;
    const k = s.sku.trim().toUpperCase();
    bySku.set(k, (bySku.get(k) ?? 0) + s.count);
    if (s.count > 0) customers.add(s.accountId);
    count += s.count; cents += s.amountCents;
  }
  return { bySku, customers, count, cents };
}

export function ProgramsPanel({
  programs, resellers, parts, prices = [], stats = [], uploads = [], initialProgramId, programUploadId,
}: {
  programs: ScanbackProgram[]; resellers: Reseller[]; parts: Part[]; prices?: PriceRow[];
  stats?: ProgramStat[]; uploads?: CenterUpload[]; initialProgramId?: string; programUploadId?: string;
}) {
  const save = useSaveScanbackProgram();
  const remove = useDeleteScanbackProgram();
  const refresh = useRefreshWorkspace();
  const { toast } = useToast();

  const sorted = useMemo(() => [...programs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [programs]);
  const pickDefault = () => sorted.find((p) => p.id === initialProgramId) ?? sorted.find((p) => !p.archived) ?? sorted[0] ?? null;

  const [selectedId, setSelectedId] = useState<string | null>(() => pickDefault()?.id ?? null);
  const [draft, setDraft] = useState<ProgramDraft>(() => { const p = pickDefault(); return p ? draftFromProgram(p, parts) : emptyDraft(); });
  const [baseFp, setBaseFp] = useState(() => fingerprint(draft));
  const [conflict, setConflict] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ label: string; run: () => void } | null>(null);
  const [paste, setPaste] = useState<{ open: boolean; uploadId: string | null }>({ open: !!programUploadId, uploadId: programUploadId ?? null });

  const dirty = fingerprint(draft) !== baseFp;
  const server = selectedId ? programs.find((p) => p.id === selectedId) ?? null : null;
  const latestProgramUpload = useMemo(() => uploads.filter((u) => u.kind === "program" && u.state === "committed").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0], [uploads]);

  const load = (p: ScanbackProgram | null, d?: ProgramDraft) => {
    const next = d ?? (p ? draftFromProgram(p, parts) : emptyDraft());
    setSelectedId(p?.id ?? null);
    setDraft(next);
    setBaseFp(p ? fingerprint(draftFromProgram(p, parts)) : fingerprint(emptyDraft()));
    setConflict(false); setError(null);
  };
  const loadRef = useRef(load); loadRef.current = load;

  // Deep link: open upload preview when the query param changes.
  useEffect(() => { if (programUploadId) setPaste({ open: true, uploadId: programUploadId }); }, [programUploadId]);

  // Background polling: adopt server changes only when the draft is clean; otherwise flag a conflict and keep edits.
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const draftVersion = draft.version;
  useEffect(() => {
    // A deliberately opened New draft must remain new, even while workspace
    // polling returns existing promotions.
    if (!selectedId) return;
    if (!server) return;
    if (server.version !== draftVersion) {
      if (dirtyRef.current) setConflict(true);
      else loadRef.current(server);
    }
  }, [server, selectedId, draftVersion, programs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const guard = (label: string, run: () => void) => (dirty ? setPending({ label, run }) : run());

  const doSave = () => {
    setError(null);
    const input = buildInput(draft, parts);
    if (typeof input === "string") { setError(input); return; }
    save.mutate({ data: input }, {
      onSuccess: (saved) => {
        toast({ title: draft.id ? "Changes saved" : "Promotion created" });
        const p = saved && typeof saved === "object" && "id" in saved ? (saved as ScanbackProgram) : null;
        if (p) load(p);
        void refresh();
      },
      onError: (e) => {
        const msg = errorMessage(e);
        if ((e as { status?: number }).status === 409 || /version|conflict|changed by/i.test(msg)) setConflict(true);
        setError(msg);
      },
    });
  };

  const toggleArchive = () => {
    if (!server) return;
    const { createdAt: _c, ...rest } = server;
    void _c;
    save.mutate({ data: { ...rest, archived: !server.archived } }, {
      onSuccess: (saved) => {
        toast({ title: server.archived ? "Promotion restored" : "Promotion archived" });
        const p = saved && typeof saved === "object" && "id" in saved ? (saved as ScanbackProgram) : null;
        if (p) load(p);
        void refresh();
      },
      onError: (e) => toast({ title: "Could not update promotion", description: errorMessage(e), variant: "destructive" }),
    });
  };

  const deletePromotion = () => {
    if (!server || remove.isPending) return;
    const deleting = server;
    remove.mutate({ id: deleting.id }, {
      onSuccess: (result) => {
        setDeleteOpen(false);
        const next = sorted.find((p) => p.id !== deleting.id && !p.archived)
          ?? sorted.find((p) => p.id !== deleting.id) ?? null;
        load(next);
        toast({
          title: "Promotion deleted",
          description: `${deleting.name} was deleted${result.deletedDraftCount ? `; ${result.deletedDraftCount} draft${result.deletedDraftCount === 1 ? "" : "s"} removed` : ""}.`,
        });
        void refresh();
      },
      onError: (e) => {
        const message = errorMessage(e);
        setDeleteOpen(false);
        toast({ title: "Could not delete promotion", description: message, variant: "destructive" });
      },
    });
  };

  const copy = (src: ProgramDraft = draft) => {
    const d: ProgramDraft = {
      ...src, id: undefined, version: undefined, archived: false,
      name: uniqueName(src.name.trim() || "Promotion", programs.map((p) => p.name)),
      lines: src.lines.map((l) => ({ ...l, caps: { ...l.caps } })),
      customerIds: [...src.customerIds],
    };
    setSelectedId(null); setDraft(d); setBaseFp(fingerprint(emptyDraft())); setConflict(false); setError(null);
    toast({ title: "Copy ready", description: "Unsaved draft. Caps and references were copied; claims were not." });
  };

  const current = statsFor(stats, draft.id);
  const history = sorted.filter((p) => p.id !== selectedId);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={selectedId ?? NEW} onValueChange={(v) => {
          if (v === NEW) return;
          const p = programs.find((x) => x.id === v);
          if (p) guard(`open ${p.name}`, () => load(p));
        }}>
          <SelectTrigger className="h-8 w-[300px] text-sm" data-testid="select-program"><SelectValue placeholder="Select promotion" /></SelectTrigger>
          <SelectContent>
            {!selectedId && <SelectItem value={NEW}>{draft.name.trim() || "Unsaved new promotion"} (draft)</SelectItem>}
            {sorted.map((p) => (
              <SelectItem key={p.id} value={p.id} data-testid={`option-program-${p.id}`}>
                {p.name}{p.archived ? " (archived)" : ""} &middot; {formatDate(p.start)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" className="h-8" data-testid="button-new-program" onClick={() => guard("start a new promotion", () => load(null))}>
          <Plus className="mr-1 h-3.5 w-3.5" /> New
        </Button>
        <Button size="sm" variant="outline" className="h-8" data-testid="button-copy-program" disabled={draft.lines.length === 0 && !draft.name}
          onClick={() => guard("copy the saved version", () => copy(server && !conflict ? draftFromProgram(server, parts) : draft))}>
          <Copy className="mr-1 h-3.5 w-3.5" /> Copy
        </Button>
        <Button size="sm" variant="outline" className="h-8" data-testid={server ? `button-archive-program-${server.id}` : "button-archive-program"} disabled={!server || save.isPending}
          onClick={() => guard(server?.archived ? "restore this promotion" : "archive this promotion", toggleArchive)}>
          {server?.archived ? <><ArchiveRestore className="mr-1 h-3.5 w-3.5" /> Restore</> : <><Archive className="mr-1 h-3.5 w-3.5" /> Archive</>}
        </Button>
        <Button size="sm" variant="destructive" className="h-8" data-testid={server ? `button-delete-program-${server.id}` : "button-delete-program"} disabled={!server || save.isPending || remove.isPending}
          onClick={() => guard("delete this promotion", () => setDeleteOpen(true))}>
          Delete
        </Button>
        <span className="mx-1 h-5 w-px bg-slate-300" />
        <Button size="sm" variant="outline" className="h-8" data-testid="button-paste-program" onClick={() => guard("paste a new program", () => setPaste({ open: true, uploadId: null }))}>
          <ClipboardPaste className="mr-1 h-3.5 w-3.5" /> Paste program
        </Button>
        {latestProgramUpload ? (
          <Button size="sm" variant="ghost" className="h-8 text-xs" data-testid="button-preview-latest-upload"
            onClick={() => guard("preview the latest program upload", () => setPaste({ open: true, uploadId: latestProgramUpload.id }))}>
            <FileSpreadsheet className="mr-1 h-3.5 w-3.5" /> Preview latest upload
          </Button>
        ) : (
          <Button size="sm" variant="ghost" className="h-8 text-xs" asChild data-testid="link-upload-program-table">
            <Link href="/upload"><FileSpreadsheet className="mr-1 h-3.5 w-3.5" /> Upload a program table</Link>
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          {dirty && <span className="text-xs font-medium text-amber-700" data-testid="text-unsaved">Unsaved changes</span>}
          {dirty && (
            <Button size="sm" variant="ghost" className="h-8" data-testid="button-discard-changes" onClick={() => load(server)}>
              <RotateCcw className="mr-1 h-3.5 w-3.5" /> Discard
            </Button>
          )}
          <Button size="sm" className="h-8" disabled={!dirty || save.isPending || conflict} onClick={doSave} data-testid="button-save-program">
            <Save className="mr-1 h-3.5 w-3.5" /> {save.isPending ? "Saving..." : draft.id ? "Save changes" : "Save promotion"}
          </Button>
        </div>
      </div>

      {conflict && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="banner-program-conflict">
          <TriangleAlert className="h-4 w-4" />
          <span className="flex-1">This promotion was changed elsewhere (now v{server?.version}). Your edits are kept here but cannot be saved over the newer version.</span>
          <Button size="sm" variant="outline" className="h-7" data-testid="button-reload-program" onClick={() => load(server)}>Reload latest (discard mine)</Button>
          <Button size="sm" variant="ghost" className="h-7" data-testid="button-copy-conflict" onClick={() => copy(draft)}>Save mine as a copy</Button>
        </div>
      )}
      {error && <p data-testid="text-program-error" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}

      <section data-testid="section-current-program">
        <div className="mb-1.5 flex items-baseline gap-3 text-xs text-slate-500">
          <span className="font-mono">{draft.id ? `v${draft.version}` : "new, not saved"}</span>
          {draft.archived && <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[11px] text-slate-700">Archived</span>}
          {draft.id && <span className="font-mono" data-testid="text-current-claimed">{current.count} claimed &middot; {money(current.cents) || "$0.00"}</span>}
          <span className="ml-auto">Claim per serial = invoiced unit price ex GST − GTM Buy Ex. References never change the claim.</span>
        </div>
        <ProgramGrid draft={draft} onChange={setDraft} resellers={resellers} parts={parts} prices={prices}
          claimedBySku={current.bySku} approvedCustomers={current.customers}
          onBlockedRemove={(id) => toast({
            title: "Customer has approved claims",
            description: `${customerLabel(resellers.find((r) => r.id === id)?.code ?? id)} cannot be removed from this promotion because approved claims exist.`,
            variant: "destructive",
          })} />
      </section>

      <section className="space-y-3 pt-2" data-testid="section-program-history">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Promotion history <span className="font-mono font-normal">({history.length})</span></h3>
        {history.length === 0 && <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-slate-500">No other promotions yet. Archived and ended promotions will stack here, newest first.</p>}
        {history.map((p) => <HistoryItem key={p.id} program={p} parts={parts} resellers={resellers} stats={stats}
          onOpen={() => guard(`open ${p.name}`, () => load(p))} />)}
      </section>

      <ProgramPasteDialog open={paste.open} uploadId={paste.uploadId} resellers={resellers}
        onOpenChange={(o) => setPaste((s) => ({ ...s, open: o }))}
        onConfirm={(d) => { setSelectedId(null); setDraft(d); setBaseFp(fingerprint(emptyDraft())); setConflict(false); setError(null);
          toast({ title: "Draft built", description: "Add a name and dates, complete any missing GTM Buy Ex, then Save promotion." }); }} />

      <Dialog open={!!pending} onOpenChange={(o) => { if (!o) setPending(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>You have unsaved edits on {draft.name.trim() || "this draft"}. Continuing to {pending?.label} will discard them.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)} data-testid="button-keep-editing">Keep editing</Button>
            <Button variant="destructive" data-testid="button-confirm-discard" onClick={() => { const r = pending?.run; setPending(null); r?.(); }}>Discard and continue</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={deleteOpen} onOpenChange={(open) => !remove.isPending && setDeleteOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {server?.name ?? "this promotion"}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the promotion and its unapproved drafts. Approved claims cannot be deleted. If this promotion has approved claims, archive it instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending} data-testid="button-cancel-delete-program">Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={!server || remove.isPending} data-testid="button-confirm-delete-program"
              onClick={(event) => { event.preventDefault(); deletePromotion(); }}>
              {remove.isPending ? "Deleting…" : `Delete ${server?.name ?? "promotion"}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function HistoryItem({ program, parts, resellers, stats, onOpen }: {
  program: ScanbackProgram; parts: Part[]; resellers: Reseller[]; stats: ProgramStat[]; onOpen: () => void;
}) {
  const d = useMemo(() => draftFromProgram(program, parts), [program, parts]);
  const s = statsFor(stats, program.id);
  return (
    <article className="opacity-60 transition-opacity hover:opacity-90" data-testid={`card-program-${program.id}`}>
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="font-semibold text-slate-800">{program.name}</span>
        <span className="font-mono text-slate-500">{formatDate(program.start)} to {formatDate(program.end)}</span>
        <StatusChip start={program.start} end={program.end} />
        {program.archived && <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-700">Archived</span>}
        <span className="font-mono text-slate-600" data-testid={`text-history-claimed-${program.id}`}>{s.count} units &middot; {money(s.cents) || "$0.00"}</span>
        <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-xs" onClick={onOpen} data-testid={`button-open-program-${program.id}`}>
          <ExternalLink className="mr-1 h-3 w-3" /> Open
        </Button>
      </div>
      <ProgramGrid draft={d} resellers={resellers} claimedBySku={s.bySku} dense idPrefix={`h${program.id}-`} />
    </article>
  );
}
