import { customerLabel, maskCustomerText } from "@/lib/customer-display";
import { useState } from "react";
import type { Reseller, ScanbackProntoPreview } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function ProntoAccounts({ preview, values, onChange, resellers, disabled }: {
  preview: ScanbackProntoPreview;
  values: Record<string, number | null>;
  onChange: (value: Record<string, number | null>) => void;
  resellers: Reseller[];
  disabled: boolean;
}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const allowed = resellers.filter(r => r.active !== false);
  const accounts = preview.accounts.filter(a => `${a.code} ${a.name}`.toLowerCase().includes(search.toLowerCase()));
  const pages = Math.max(1, Math.ceil(accounts.length / 12)), currentPage = Math.min(page, pages - 1);
  const mapped = Object.values(values).filter(id => id != null).length;
  const suggest = () => onChange({
    ...values,
    ...Object.fromEntries(preview.accounts.filter(a => a.suggestedAccountId != null && !Object.hasOwn(values, a.code))
      .map(a => [a.code, a.suggestedAccountId])),
  });
  return (
    <section className="space-y-3 border-t p-4" data-testid="pronto-account-mapping">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Pronto POS account mapping</h3>
        <p className="text-xs text-slate-600">
          {preview.sourceRows.toLocaleString()} invoice/credit rows contain {preview.sourceSerialEvents.toLocaleString()} serial events.
          {" "}Item Price is the invoiced unit price ex GST; Item Cost, Line Cost Ex and RRP are not used.
        </p>
          <p className="text-xs text-slate-600">Map Pronto codes to any active reseller in Settings. Unselected accounts stay excluded. Name-prefix suggestions are hints and require your review; uncatalogued SKUs are retained as evidence but never added to the product catalogue. Credits without serials appear in Upload Center, where you can enter returned serials or mark the credit reviewed with a note.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input className="h-8 max-w-xs" placeholder="Find Pronto code or reseller…" aria-label="Find Pronto account"
          value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} data-testid="input-pronto-search" />
        <Button type="button" size="sm" variant="outline" onClick={suggest} disabled={disabled}
          data-testid="button-pronto-suggestions">Use suggested mappings</Button>
        <span className="text-xs text-slate-500">{mapped} of {preview.accounts.length} source accounts mapped</span>
      </div>
      <div className="max-h-96 overflow-auto rounded-md border">
        <Table>
          <TableHeader><TableRow><TableHead>Pronto account</TableHead><TableHead>Rows / serials</TableHead><TableHead>ChannelPulse reseller</TableHead></TableRow></TableHeader>
          <TableBody>{accounts.slice(currentPage * 12, currentPage * 12 + 12).map(a => (
            <TableRow key={a.code}>
              <TableCell className="min-w-36"><p className="font-mono text-xs">{maskCustomerText(a.code) || "(missing)"}</p><p className="max-w-64 text-xs">{a.name || "(unnamed)"}</p></TableCell>
              <TableCell className="text-xs tabular-nums">{a.rowCount.toLocaleString()} / {a.serialCount.toLocaleString()}</TableCell>
              <TableCell>
                <Select disabled={disabled} value={values[a.code] == null ? "__exclude" : String(values[a.code])}
                  onValueChange={v => onChange({ ...values, [a.code]: v === "__exclude" ? null : Number(v) })}>
                  <SelectTrigger className="h-8 min-w-40 text-xs" aria-label={`Map Pronto account ${maskCustomerText(a.code)}`} data-testid={`select-pronto-${a.code}`}><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="__exclude">Exclude this account</SelectItem>
                    {allowed.map(r => <SelectItem key={r.id} value={String(r.id)}>{customerLabel(r.code)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>Page {currentPage + 1} of {pages} · {accounts.length} matching accounts</span>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</Button>
          <Button size="sm" variant="outline" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>Next</Button>
        </div>
      </div>
      <div className="rounded-md bg-slate-50 p-3 text-xs" data-testid="pronto-exclusion-summary">
        <p className="font-medium">Applied preview: {preview.includedSourceRows.toLocaleString()} source rows included; {preview.excludedSourceRows.toLocaleString()} excluded.</p>
        {Object.entries(preview.excludedCounts).map(([reason, count]) => <p key={reason} className="mt-1">{reason}: {count.toLocaleString()} rows</p>)}
        <p className="mt-2 text-slate-500">Excluded rows are not invoice evidence. A claim without matching serial evidence stays rejected. Type uncatalogued SKUs on promotion lines to make them eligible. Apply mapping to refresh these counts.</p>
      </div>
      {preview.excludedSamples.length > 0 && <details className="text-xs">
         <summary className="cursor-pointer font-medium">Review excluded rows, including unmatched credits (up to 15 per reason)</summary>
        <div className="mt-2 max-h-56 overflow-auto rounded border">
           <Table><TableHeader><TableRow><TableHead>Source row</TableHead><TableHead>Account / SKU</TableHead><TableHead>Invoice / Qty</TableHead><TableHead>Reason</TableHead></TableRow></TableHeader>
            <TableBody>{preview.excludedSamples.map(a => <TableRow key={a.row}>
               <TableCell>{a.row}</TableCell><TableCell>{maskCustomerText(a.accountCode)} · {a.sku}</TableCell>
               <TableCell>{a.invoice || "—"} · {a.quantity}</TableCell><TableCell>{a.reason}</TableCell>
            </TableRow>)}</TableBody>
          </Table>
        </div>
      </details>}
    </section>
  );
}
