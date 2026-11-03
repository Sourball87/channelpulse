import { customerLabel } from "@/lib/customer-display";
import { useEffect, useState } from "react";
import {
  useSaveScanbackProgram,
  type Part,
  type Reseller,
  type ScanbackProgram,
  type ScanbackProgramInput,
} from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { centsToInput, errorMessage, parseCents, useRefreshWorkspace } from "./shared";

type LineDraft = { sku: string; gtm: string; caps: Record<number, string> };

export function ProgramEditor({
  open,
  onOpenChange,
  program,
  resellers,
  parts,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  program: ScanbackProgram | null;
  resellers: Reseller[];
  parts: Part[];
}) {
  const { toast } = useToast();
  const refresh = useRefreshWorkspace();
  const save = useSaveScanbackProgram();
  const [name, setName] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [notes, setNotes] = useState("");
  const [customers, setCustomers] = useState<number[]>([]);
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(program?.name ?? "");
    setStart(program?.start?.slice(0, 10) ?? "");
    setEnd(program?.end?.slice(0, 10) ?? "");
    setNotes(program?.notes ?? "");
    setCustomers(program?.customerIds ?? []);
    setLines(
      (program?.lines ?? []).map((l) => ({
        sku: l.sku ?? parts.find(p => p.id === l.partId)?.part_no ?? "",
        gtm: centsToInput(l.gtmBuyCents),
        caps: Object.fromEntries(l.caps.map((c) => [c.resellerId, c.quantity == null ? "" : String(c.quantity)])),
      })),
    );
  }, [open, program]);

  const toggleCustomer = (id: number) =>
    setCustomers((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const updateLine = (i: number, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const submit = () => {
    setError(null);
    if (!name.trim()) return setError("Promotion name is required.");
    if (!start || !end) return setError("Start and end dates are required.");
    if (end < start) return setError("End date must be on or after the start date.");
    if (customers.length === 0) return setError("Select at least one eligible customer.");
    if (lines.length === 0) return setError("Add at least one eligible SKU.");
    const seen = new Set<string>();
    const out: ScanbackProgramInput["lines"] = [];
    for (const [i, l] of lines.entries()) {
      const sku = l.sku.trim().toUpperCase();
      if (!sku) return setError(`SKU line ${i + 1}: enter a SKU.`);
      if (seen.has(sku)) return setError(`SKU line ${i + 1}: SKU is listed twice.`);
      seen.add(sku);
      const gtm = parseCents(l.gtm);
      if (gtm == null || Number.isNaN(gtm) || gtm < 1)
        return setError(`SKU line ${i + 1}: GTM Buy Ex must be a positive amount with up to 2 decimals.`);
      const caps = [];
      for (const cid of customers) {
        const raw = (l.caps[cid] ?? "").trim();
        if (raw === "") caps.push({ resellerId: cid, quantity: null });
        else if (!/^\d+$/.test(raw)) return setError(`SKU line ${i + 1}: caps must be whole numbers (blank = unlimited).`);
        else caps.push({ resellerId: cid, quantity: Number(raw) });
      }
      const part = parts.find(p => p.part_no.toUpperCase() === sku);
      out.push({ sku, partId: part?.id ?? null, gtmBuyCents: gtm, caps });
    }
    const data: ScanbackProgramInput = {
      ...(program ? { id: program.id, version: program.version, archived: program.archived } : {}),
      name: name.trim(),
      start,
      end,
      notes,
      customerIds: customers,
      lines: out,
    };
    save.mutate(
      { data },
      {
        onSuccess: () => {
          toast({ title: program ? "Promotion updated" : "Promotion created" });
          refresh();
          onOpenChange(false);
        },
        onError: (e) => setError(errorMessage(e)),
      },
    );
  };

  const selectedCustomers = resellers.filter((r) => customers.includes(r.id));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{program ? `Edit ${program.name}` : "New scanback promotion"}</DialogTitle>
          <DialogDescription>
            Claim per serial = reseller invoiced unit price ex GST minus GTM Buy Ex. Your own purchase cost is never used.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-[2fr_1fr_1fr]">
          <div className="space-y-1.5">
            <Label htmlFor="sb-name">Name</Label>
            <Input id="sb-name" data-testid="input-program-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sb-start">Start (inclusive)</Label>
            <Input id="sb-start" type="date" data-testid="input-program-start" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sb-end">End (inclusive)</Label>
            <Input id="sb-end" type="date" data-testid="input-program-end" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sb-notes">Notes</Label>
          <Textarea id="sb-notes" rows={2} data-testid="input-program-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        <div className="space-y-2">
          <Label>Eligible customers</Label>
          <div className="grid max-h-40 gap-1.5 overflow-y-auto rounded-md border p-3 sm:grid-cols-2 md:grid-cols-3">
            {resellers.length === 0 && <p className="text-sm text-muted-foreground">No accounts set up yet. Add them in Settings.</p>}
            {resellers.map((r) => (
              <label key={r.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  data-testid={`checkbox-customer-${r.id}`}
                  checked={customers.includes(r.id)}
                  onCheckedChange={() => toggleCustomer(r.id)}
                />
                <span className="font-mono text-xs text-slate-500">{customerLabel(r.code)}</span>
                <span className="truncate">{r.name}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>SKUs, GTM Buy Ex and caps</Label>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="button-add-sku-line"
              onClick={() => setLines((ls) => [...ls, { sku: "", gtm: "", caps: {} }])}
            >
              <Plus className="mr-1 h-3.5 w-3.5" /> Add SKU
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Caps are per customer per SKU. Blank means unlimited; 0 means that customer is ineligible for the SKU.
          </p>
          <p className="text-xs text-muted-foreground">
            Type the SKU code directly. New codes do not create product-catalogue entries; invoice evidence must use the exact same code.
          </p>
          {lines.map((l, i) => (
            <div key={i} className="rounded-md border bg-slate-50/50 p-3 space-y-2">
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-[220px] flex-1 space-y-1">
                  <Label className="text-xs text-slate-500" htmlFor={`input-line-sku-${i}`}>SKU</Label>
                  <Input id={`input-line-sku-${i}`} autoComplete="off" maxLength={120} placeholder="Type SKU code"
                    data-testid={`input-line-sku-${i}`} value={l.sku}
                    onChange={(e) => updateLine(i, { sku: e.target.value })} />
                </div>
                <div className="w-40 space-y-1">
                  <span className="text-xs text-slate-500">GTM Buy Ex ($)</span>
                  <Input
                    inputMode="decimal"
                    placeholder="0.00"
                    data-testid={`input-line-gtm-${i}`}
                    value={l.gtm}
                    onChange={(e) => updateLine(i, { gtm: e.target.value })}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove SKU line"
                  data-testid={`button-remove-line-${i}`}
                  onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}
                >
                  <Trash2 className="h-4 w-4 text-rose-600" />
                </Button>
              </div>
              {selectedCustomers.length > 0 && (
                <div className="grid gap-2 sm:grid-cols-3 md:grid-cols-4">
                  {selectedCustomers.map((c) => (
                    <label key={c.id} className="flex items-center gap-2 text-xs">
                      <span className="w-16 truncate font-mono text-slate-500">{customerLabel(c.code)}</span>
                      <Input
                        className="h-7"
                        placeholder="Unlimited"
                        inputMode="numeric"
                        data-testid={`input-cap-${i}-${c.id}`}
                        value={l.caps[c.id] ?? ""}
                        onChange={(e) => updateLine(i, { caps: { ...l.caps, [c.id]: e.target.value } })}
                      />
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {error && <p data-testid="text-program-error" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-program">Cancel</Button>
          <Button onClick={submit} disabled={save.isPending} data-testid="button-save-program">
            {save.isPending ? "Saving..." : "Save promotion"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
