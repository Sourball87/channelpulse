import { customerLabel } from "@/lib/customer-display";
import { useMemo, useState } from "react";
import { getExportScanbackBatchUrl, type Reseller, type ScanbackBatch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Search } from "lucide-react";
import { SectionEmpty, StatusPill, formatCents, formatDate, formatDateTime } from "./shared";

const ALL = "__all";

export function HistoryPanel({ batches, resellers }: { batches: ScanbackBatch[]; resellers: Reseller[] }) {
  const [program, setProgram] = useState(ALL);
  const [account, setAccount] = useState(ALL);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<ScanbackBatch | null>(null);
  const programNames = useMemo(() => [...new Set(batches.map((b) => b.programName))].sort(), [batches]);
  const accountCodes = useMemo(() => [...new Set(batches.map((b) => b.accountCode))].sort(), [batches]);

  const filtered = batches
    .filter((b) => program === ALL || b.programName === program)
    .filter((b) => account === ALL || b.accountCode === account)
    .filter((b) => !from || b.createdAt.slice(0, 10) >= from)
    .filter((b) => !to || b.createdAt.slice(0, 10) <= to)
    .filter((b) => {
      const s = q.trim().toLowerCase();
      if (!s) return true;
      return b.reference.toLowerCase().includes(s) || b.rows.some((r) => r.serial.toLowerCase().includes(s) || r.invoice.toLowerCase().includes(s));
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-background p-4">
        <Select value={program} onValueChange={setProgram}>
          <SelectTrigger className="w-52" data-testid="select-history-program"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value={ALL}>All promotions</SelectItem>{programNames.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={account} onValueChange={setAccount}>
          <SelectTrigger className="w-44" data-testid="select-history-account"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value={ALL}>All accounts</SelectItem>{accountCodes.map((c) => <SelectItem key={c} value={c}>{customerLabel(c)}</SelectItem>)}</SelectContent>
        </Select>
        <Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Approved from" data-testid="input-history-from" />
        <Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Approved to" data-testid="input-history-to" />
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <Input className="pl-8" placeholder="Reference, serial or invoice" value={q} onChange={(e) => setQ(e.target.value)} data-testid="input-history-search" />
        </div>
      </div>

      {filtered.length === 0 ? (
        <SectionEmpty title={batches.length ? "No batches match these filters" : "No approved claims yet"} body="Approved claim batches and imported historical claims appear here with their saved snapshots." />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-background">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Reference</TableHead><TableHead>Promotion</TableHead><TableHead>Account</TableHead><TableHead>Approved</TableHead>
              <TableHead>Basis / period</TableHead><TableHead className="text-right">Serials</TableHead><TableHead className="text-right">Total</TableHead><TableHead className="text-right">Export</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {filtered.map((b) => (
                <TableRow key={b.id} className="cursor-pointer hover:bg-cyan-50/40" onClick={() => setOpen(b)} data-testid={`row-batch-${b.id}`}>
                  <TableCell className="font-mono text-xs font-semibold">{b.reference}{b.historical && <Badge variant="secondary" className="ml-2">Historical</Badge>}</TableCell>
                  <TableCell>{b.programName}</TableCell>
                  <TableCell><span className="font-mono text-xs">{customerLabel(b.accountCode)}</span></TableCell>
                  <TableCell className="text-xs">{formatDateTime(b.createdAt)}</TableCell>
                  <TableCell className="text-xs">{b.basis === "sell" ? "Sale date" : b.basis === "invoice" ? "Invoice date" : b.basis || "-"}{b.from && <span className="block text-slate-500">{formatDate(b.from)} to {formatDate(b.to)}</span>}</TableCell>
                  <TableCell className="text-right tabular-nums">{b.approvedCount}</TableCell>
                  <TableCell className="text-right font-mono font-semibold">{formatCents(b.totalCents)}</TableCell>
                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" asChild data-testid={`link-batch-xlsx-${b.id}`}><a href={getExportScanbackBatchUrl(b.id, "xlsx")}>XLSX</a></Button>
                      <Button size="sm" variant="ghost" asChild data-testid={`link-batch-csv-${b.id}`}><a href={getExportScanbackBatchUrl(b.id, "csv")}>CSV</a></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="max-w-5xl max-h-[90dvh] overflow-y-auto">
          {open && (
            <>
              <DialogHeader>
                <DialogTitle className="font-mono">{open.reference}</DialogTitle>
                <DialogDescription>
                  {open.programName} &middot; {customerLabel(open.accountCode)} &middot; {open.historical ? "Imported historical claim" : `Approved ${formatDateTime(open.createdAt)}`} &middot; {formatCents(open.totalCents)}.
                  Recorded claim decision from saved snapshot, not a payment.
                </DialogDescription>
              </DialogHeader>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" asChild><a href={getExportScanbackBatchUrl(open.id, "xlsx")}>Statement XLSX</a></Button>
                <Button size="sm" variant="outline" asChild><a href={getExportScanbackBatchUrl(open.id, "csv")}>CSV</a></Button>
              </div>
              <Table>
                <TableHeader><TableRow>
                  <TableHead>Status</TableHead><TableHead>Serial</TableHead><TableHead>SKU</TableHead><TableHead>Date</TableHead><TableHead>Invoice</TableHead>
                  <TableHead className="text-right">Inv. unit ex GST</TableHead><TableHead className="text-right">GTM Buy Ex</TableHead><TableHead className="text-right">Claim</TableHead><TableHead>Reason / source</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {open.rows.map((r, i) => (
                    <TableRow key={`${r.rowIndex}-${i}`}>
                      <TableCell><StatusPill status={r.status} /></TableCell>
                      <TableCell className="font-mono text-xs">{r.serial}</TableCell>
                      <TableCell className="font-mono text-xs">{r.sku}</TableCell>
                      <TableCell className="text-xs">{r.date}</TableCell>
                      <TableCell className="font-mono text-xs">{r.invoice}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{formatCents(r.unitPriceCents)}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{formatCents(r.gtmBuyCents)}</TableCell>
                      <TableCell className="text-right font-mono text-xs font-semibold">{formatCents(r.amountCents)}</TableCell>
                      <TableCell className="text-xs text-slate-600">{r.reason}{r.source && <span className="block text-slate-400">{r.source}</span>}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
