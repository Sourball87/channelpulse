import { useState } from "react";
import { useGetParts, useGetResellers, type ScanbackUploadKind } from "@workspace/api-client-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ProgramsPanel } from "@/components/scanback/programs-panel";
import { ImportPanel } from "@/components/scanback/import-panel";
import { VerifyPanel } from "@/components/scanback/verify-panel";
import { HistoryPanel } from "@/components/scanback/history-panel";
import { errorMessage, formatCents, useScanbackWorkspace } from "@/components/scanback/shared";

export default function ScanbackClaims() {
  const ws = useScanbackWorkspace();
  const resellersQ = useGetResellers();
  const partsQ = useGetParts();
  const [tab, setTab] = useState("verify");
  const [importKind, setImportKind] = useState<ScanbackUploadKind>("claim");
  const resellers = resellersQ.data ?? [];
  const parts = partsQ.data ?? [];
  const data = ws.data;
  const approvedTotal = data?.batches.filter((b) => !b.historical).reduce((s, b) => s + b.totalCents, 0) ?? 0;

  return (
    <div className="flex h-full flex-col bg-muted/20">
      <header className="flex-none border-b bg-background px-6 py-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Scanback Claims</h1>
            <p className="text-sm text-muted-foreground">Claim per serial = reseller invoiced unit price ex GST minus GTM Buy Ex. One serial is payable once across all promotions.</p>
          </div>
          {data && (
            <dl className="flex gap-6 text-right">
              <div><dt className="text-[11px] uppercase tracking-wider text-slate-500">Active promotions</dt><dd className="font-mono text-lg font-semibold" data-testid="text-active-programs">{data.programs.filter((p) => !p.archived).length}</dd></div>
              <div><dt className="text-[11px] uppercase tracking-wider text-slate-500">Approved to date</dt><dd className="font-mono text-lg font-semibold" data-testid="text-approved-total">{formatCents(approvedTotal)}</dd></div>
            </dl>
          )}
        </div>
      </header>
      <div className="flex-1 overflow-auto p-4 md:p-6">
        {ws.isLoading ? (
          <div className="space-y-3"><Skeleton className="h-10 w-96" /><Skeleton className="h-32 w-full" /><Skeleton className="h-64 w-full" /></div>
        ) : ws.isError || !data ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-6 text-sm text-rose-800">
            <p className="font-semibold">Could not load scanback workspace</p>
            <p className="mt-1">{errorMessage(ws.error)}</p>
            <Button className="mt-3" size="sm" variant="outline" onClick={() => ws.refetch()} data-testid="button-retry-workspace">Retry</Button>
          </div>
        ) : (
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="flex-wrap h-auto">
              <TabsTrigger value="verify" data-testid="tab-verify">Verify Claims</TabsTrigger>
              <TabsTrigger value="imports" data-testid="tab-imports">Imports</TabsTrigger>
              <TabsTrigger value="programs" data-testid="tab-programs">Programs</TabsTrigger>
              <TabsTrigger value="history" data-testid="tab-history">Claims History</TabsTrigger>
            </TabsList>
            <TabsContent value="verify" className="mt-4">
              <VerifyPanel programs={data.programs} imports={data.imports} drafts={data.drafts} resellers={resellers} onApproved={() => undefined} />
            </TabsContent>
            <TabsContent value="imports" className="mt-4">
              <ImportPanel imports={data.imports} resellers={resellers} kind={importKind} onKindChange={setImportKind} />
            </TabsContent>
            <TabsContent value="programs" className="mt-4">
              <ProgramsPanel programs={data.programs} resellers={resellers} parts={parts} />
            </TabsContent>
            <TabsContent value="history" className="mt-4">
              <HistoryPanel batches={data.batches} resellers={resellers} onImportHistory={() => { setImportKind("history"); setTab("imports"); }} />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  );
}
