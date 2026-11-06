import type { ReactNode } from "react";
import type { Part, Reseller } from "@workspace/api-client-react";
import { Plus, RefreshCw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { customerLabel } from "@/lib/customer-display";
import type { PriceRow } from "@/lib/upload-center";
import { cn } from "@/lib/utils";
import {
  cappedQty, discFromDraft, emptyLine, money, programStatus, staFromDraft, toCents, withPriceRefs,
  type DraftLine, type ProgramDraft,
} from "@/lib/program-draft";

const STATUS_TONE = {
  upcoming: "bg-sky-50 text-sky-800 ring-sky-600/25",
  live: "bg-emerald-50 text-emerald-800 ring-emerald-600/25",
  ended: "bg-slate-100 text-slate-600 ring-slate-400/30",
  unset: "bg-amber-50 text-amber-800 ring-amber-600/25",
};

export function StatusChip({ start, end, testId }: { start: string; end: string; testId?: string }) {
  const s = programStatus(start, end);
  return <span data-testid={testId} className={cn("inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset", STATUS_TONE[s.kind])}>{s.label}</span>;
}

const cell = "border-r border-slate-200 last:border-r-0";
const inputCls = "h-7 w-full bg-transparent px-1.5 font-mono text-xs tabular-nums outline-none focus:bg-cyan-50 focus:ring-1 focus:ring-inset focus:ring-cyan-500 placeholder:text-slate-300";
const invalid = "bg-rose-50 text-rose-700";
const badMoney = (raw: string) => { const c = toCents(raw); return c != null && Number.isNaN(c); };

export function ProgramGrid({
  draft, onChange, resellers, parts = [], prices = [], claimedBySku, approvedCustomers = new Set<number>(), dense = false, onBlockedRemove, idPrefix = "",
}: {
  draft: ProgramDraft;
  onChange?: (d: ProgramDraft) => void;
  resellers: Reseller[];
  parts?: Part[];
  prices?: PriceRow[];
  claimedBySku: Map<string, number>;
  approvedCustomers?: Set<number>;
  dense?: boolean;
  onBlockedRemove?: (resellerId: number) => void;
  idPrefix?: string;
}) {
  const ro = !onChange;
  const resById = new Map(resellers.map((r) => [r.id, r]));
  const set = (patch: Partial<ProgramDraft>) => onChange?.({ ...draft, ...patch });
  const setLine = (i: number, l: DraftLine) => set({ lines: draft.lines.map((x, idx) => (idx === i ? l : x)) });
  const addable = resellers.filter((r) => !draft.customerIds.includes(r.id));
  const custSums = draft.customerIds.map((id) => draft.lines.reduce((s, l) => { const v = (l.caps[id] ?? "").trim(); return /^\d+$/.test(v) ? s + Number(v) : s; }, 0));
  const totalCapped = draft.lines.reduce((s, l) => s + cappedQty(l.caps, draft.customerIds), 0);
  const totalClaimed = draft.lines.reduce((s, l) => s + (claimedBySku.get(l.sku.trim().toUpperCase()) ?? 0), 0);
  const tid = (s: string) => `${idPrefix}${s}`;
  const th = cn("whitespace-nowrap px-1.5 font-medium text-slate-500 text-right", dense ? "py-1 text-[10px]" : "py-1.5 text-[11px] uppercase tracking-wide");
  const td = cn("px-1.5 text-right font-mono tabular-nums whitespace-nowrap", dense ? "py-0.5 text-[11px]" : "text-xs");
  const listId = `${idPrefix}sku-options`;

  const moneyCell = (i: number, l: DraftLine, field: "rrp" | "gtmInc" | "dd" | "t1" | "gtmBuy", testId: string) =>
    ro ? <td className={cn(cell, td)}>{money(toCents(l[field]))}</td> : (
      <td className={cn(cell, "p-0", badMoney(l[field]) && invalid)}>
        <input inputMode="decimal" className={cn(inputCls, "text-right", field === "gtmBuy" && "font-semibold text-slate-900")}
          value={l[field]} placeholder={field === "gtmBuy" ? "required" : ""} data-testid={testId}
          onChange={(e) => setLine(i, { ...l, [field]: e.target.value })} />
      </td>
    );

  return (
    <div className={cn("overflow-hidden rounded-md border border-slate-300 bg-card", dense && "border-slate-200")}>
      {/* Header band */}
      {!ro ? (
        <div className="grid gap-x-3 gap-y-2 border-b border-slate-300 bg-slate-50/80 px-3 py-2.5 md:grid-cols-[minmax(200px,2fr)_150px_150px_auto_minmax(180px,2fr)] md:items-end">
          <BandField label="Promotion">
            <input className="h-8 w-full rounded border border-slate-300 bg-background px-2 text-sm font-semibold outline-none focus:ring-2 focus:ring-cyan-500/40" value={draft.name}
              placeholder="e.g. Q3 Odyssey monitor scanback" data-testid="input-program-name" onChange={(e) => set({ name: e.target.value })} />
          </BandField>
          <BandField label="Start (incl.)">
            <input type="date" className="h-8 w-full rounded border border-slate-300 bg-background px-2 font-mono text-xs outline-none focus:ring-2 focus:ring-cyan-500/40" value={draft.start}
              data-testid="input-program-start" onChange={(e) => set({ start: e.target.value })} />
          </BandField>
          <BandField label="End (incl.)">
            <input type="date" className="h-8 w-full rounded border border-slate-300 bg-background px-2 font-mono text-xs outline-none focus:ring-2 focus:ring-cyan-500/40" value={draft.end}
              data-testid="input-program-end" onChange={(e) => set({ end: e.target.value })} />
          </BandField>
          <BandField label="Status"><div className="flex h-8 items-center"><StatusChip start={draft.start} end={draft.end} testId="status-program" /></div></BandField>
          <BandField label="Notes">
            <input className="h-8 w-full rounded border border-slate-300 bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-cyan-500/40" value={draft.notes}
              data-testid="input-program-notes" onChange={(e) => set({ notes: e.target.value })} />
          </BandField>
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead className="bg-slate-100/80">
            <tr className="border-b border-slate-300">
              <th className={cn(cell, th, "text-left", dense ? "min-w-[110px]" : "min-w-[180px]")}>SKU</th>
              <th className={cn(cell, th)}>RRP Inc</th>
              <th className={cn(cell, th)}>GTM Inc</th>
              <th className={cn(cell, th)}>Disc %</th>
              <th className={cn(cell, th)}>DD Cost Ex</th>
              <th className={cn(cell, th)}>T1 Ex</th>
              <th className={cn(cell, th, "text-slate-800")}>GTM Buy Ex</th>
              <th className={cn(cell, th)} title="T1 Ex minus GTM Buy Ex">STA (T1 − GTM Buy)</th>
              <th className={cn(cell, th)}>Capped Qty</th>
              {draft.customerIds.map((id) => {
                const blocked = approvedCustomers.has(id);
                const code = customerLabel(resById.get(id)?.code ?? `#${id}`);
                return (
                  <th key={id} className={cn(cell, th, "bg-cyan-50/70 text-cyan-900", !dense && "min-w-[78px]")} data-testid={tid(`header-customer-${id}`)}>
                    <span className="inline-flex items-center gap-1">
                      {code}
                      {!ro && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button type="button" aria-label={`Remove ${code}`} data-testid={`button-remove-customer-${id}`}
                              className={cn("rounded p-0.5", blocked ? "cursor-not-allowed text-slate-300" : "text-slate-400 hover:bg-rose-100 hover:text-rose-700")}
                              onClick={() => blocked ? onBlockedRemove?.(id) : set({ customerIds: draft.customerIds.filter((c) => c !== id) })}>
                              <X className="h-3 w-3" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>{blocked ? `${code} has approved claims on this promotion and cannot be removed` : `Remove ${code} from this promotion`}</TooltipContent>
                        </Tooltip>
                      )}
                    </span>
                  </th>
                );
              })}
              <th className={cn(cell, th)}>Claimed</th>
            </tr>
          </thead>
          <tbody>
            {draft.lines.length === 0 && (
              <tr><td colSpan={10 + draft.customerIds.length} className="px-3 py-6 text-center text-xs text-slate-500">No SKUs yet. Add a SKU to start the program table.</td></tr>
            )}
            {draft.lines.map((l, i) => {
              const sku = l.sku.trim().toUpperCase();
              const sta = staFromDraft(l);
              const dup = !!sku && draft.lines.findIndex((x) => x.sku.trim().toUpperCase() === sku) !== i;
              const gtmMissing = !ro && !l.gtmBuy.trim();
              return (
                <tr key={l.key} className={cn("border-b border-slate-200 last:border-b-0", !ro && "hover:bg-slate-50/60")} data-testid={tid(`row-program-line-${i}`)}>
                  {ro ? <td className={cn(cell, td, "text-left text-slate-800")}>{l.sku}</td> : (
                    <td className={cn(cell, "p-0", (dup || (!sku && l.gtmBuy)) && invalid)}>
                      <div className="flex items-center">
                        <input list={listId} autoComplete="off" maxLength={120} placeholder="Type or pick SKU" className={cn(inputCls, "uppercase")}
                          value={l.sku} data-testid={`input-line-sku-${i}`}
                          onChange={(e) => setLine(i, withPriceRefs({ ...l, sku: e.target.value }, prices))} />
                        <button type="button" aria-label="Remove SKU row" data-testid={`button-remove-line-${i}`}
                          className="mr-1 rounded p-1 text-slate-300 hover:bg-rose-50 hover:text-rose-600"
                          onClick={() => set({ lines: draft.lines.filter((_, idx) => idx !== i) })}>
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </td>
                  )}
                  {moneyCell(i, l, "rrp", `input-line-rrp-${i}`)}
                  {moneyCell(i, l, "gtmInc", `input-line-gtminc-${i}`)}
                  <td className={cn(cell, td, "text-slate-500")} data-testid={tid(`text-line-disc-${i}`)}>{discFromDraft(l)}</td>
                  {moneyCell(i, l, "dd", `input-line-dd-${i}`)}
                  {moneyCell(i, l, "t1", `input-line-t1-${i}`)}
                  {ro ? <td className={cn(cell, td, "font-semibold text-slate-800")}>{money(toCents(l.gtmBuy))}</td> : (
                    <td className={cn(cell, "p-0 bg-amber-50/40", (badMoney(l.gtmBuy) || gtmMissing) && invalid)}>
                      <input inputMode="decimal" className={cn(inputCls, "text-right font-semibold text-slate-900")} value={l.gtmBuy} placeholder="required"
                        data-testid={`input-line-gtm-${i}`} onChange={(e) => setLine(i, { ...l, gtmBuy: e.target.value })} />
                    </td>
                  )}
                  <td className={cn(cell, td, sta != null && sta < 0 ? "text-rose-700" : "text-slate-600")} data-testid={tid(`text-line-sta-${i}`)}>{money(sta)}</td>
                  <td className={cn(cell, td, "text-slate-700")} data-testid={tid(`text-line-capped-${i}`)}>{cappedQty(l.caps, draft.customerIds)}</td>
                  {draft.customerIds.map((id) => {
                    const v = l.caps[id] ?? "";
                    const bad = v.trim() !== "" && !/^\d+$/.test(v.trim());
                    return ro ? (
                      <td key={id} className={cn(cell, td, v.trim() === "0" && "text-slate-400")}>{v}</td>
                    ) : (
                      <td key={id} className={cn(cell, "p-0 bg-cyan-50/30", bad && invalid)}>
                        <input inputMode="numeric" className={cn(inputCls, "text-right")} value={v} placeholder="-"
                          data-testid={`input-cap-${i}-${id}`} onChange={(e) => setLine(i, { ...l, caps: { ...l.caps, [id]: e.target.value } })} />
                      </td>
                    );
                  })}
                  <td className={cn(cell, td, "font-semibold text-slate-800")} data-testid={tid(`text-line-claimed-${i}`)}>{claimedBySku.get(sku) ?? 0}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-300 bg-slate-50">
              <td colSpan={8} className={cn(cell, td, "text-left font-sans font-medium text-slate-600")}>Total of SKU caps</td>
              <td className={cn(cell, td, "font-semibold")} data-testid={tid("text-total-capped")}>{totalCapped}</td>
              {draft.customerIds.map((id, k) => (
                <td key={id} className={cn(cell, td, "font-semibold text-cyan-900")} data-testid={tid(`text-cap-total-${id}`)}>{custSums[k]}</td>
              ))}
              <td className={cn(cell, td, "font-semibold")} data-testid={tid("text-total-claimed")}>{totalClaimed}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {!ro && (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-300 bg-slate-50/80 px-3 py-2">
          <Button type="button" size="sm" variant="outline" className="h-7" data-testid="button-add-sku-line"
            onClick={() => set({ lines: [...draft.lines, emptyLine()] })}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add SKU
          </Button>
          <Select value="" onValueChange={(v) => set({ customerIds: [...draft.customerIds, Number(v)] })} disabled={addable.length === 0}>
            <SelectTrigger className="h-7 w-[170px] text-xs" data-testid="select-add-customer"><SelectValue placeholder="+ Add customer" /></SelectTrigger>
            <SelectContent>
              {addable.map((r) => (
                <SelectItem key={r.id} value={String(r.id)} data-testid={`option-add-customer-${r.id}`}>{customerLabel(r.code)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" data-testid="button-refresh-prices" disabled={prices.length === 0}
            onClick={() => set({ lines: draft.lines.map((l) => (l.sku.trim() && prices.some((p) => p.sku.trim().toUpperCase() === l.sku.trim().toUpperCase()) ? withPriceRefs(l, prices) : l)) })}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" /> Refresh from price list
          </Button>
          <p className="ml-auto text-[11px] text-slate-500">
            Blank cap = unlimited (not counted in Capped Qty) &middot; 0 = not eligible &middot; RRP, GTM Inc, DD Cost and T1 are reference only
          </p>
          <datalist id={listId}>
            {[...new Set([...prices.map((p) => p.sku.toUpperCase()), ...parts.map((p) => p.part_no.toUpperCase())])].map((s) => <option key={s} value={s} />)}
          </datalist>
        </div>
      )}
    </div>
  );
}

function BandField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-0 space-y-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</span>
      {children}
    </label>
  );
}
