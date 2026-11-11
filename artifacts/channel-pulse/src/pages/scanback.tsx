import { useEffect, useMemo, useState } from "react";
import type { ProgramStat } from "@/lib/program-draft";
import { Link, useLocation, useSearch } from "wouter";
import { SerialLookup } from "@/components/scanback/serial-lookup";
import { useGetParts, useGetResellers } from "@workspace/api-client-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { UploadCloud } from "lucide-react";
import { ProgramsPanel } from "@/components/scanback/programs-panel";
import { VerifyPanel } from "@/components/scanback/verify-panel";
import { HistoryPanel } from "@/components/scanback/history-panel";
import { errorMessage, formatCents, useScanbackWorkspace } from "@/components/scanback/shared";
import { useUploadCenter } from "@/lib/upload-center";
import { ClaimsByWeekPanel } from "@/components/scanback/claims-by-week";

export default function ScanbackClaims() {
  const ws = useScanbackWorkspace();
  const resellersQ = useGetResellers();
  const partsQ = useGetParts();
  const center = useUploadCenter();
  const search = useSearch();
  const query = useMemo(() => new URLSearchParams(search), [search]);
  const programUploadId = query.get("programUpload") ?? undefined;
  const [tab, setTab] = useState(() => query.get("tab") ?? (programUploadId ? "programs" : "claims"));
  useEffect(() => { const t = query.get("tab") ?? (programUploadId ? "programs" : null); if (t) setTab(t); }, [query, programUploadId]);
  const [, navigate] = useLocation();
  const serialParam = query.get("serial") ?? "";
  const openSerial = (serial: string) => {
    const q = new URLSearchParams(search); q.set("tab", "serials"); q.set("serial", serial);
    setTab("serials"); navigate(`/scanback?${q.toString()}`);
  };
  const resellers = resellersQ.data ?? [];
  const parts = partsQ.data ?? [];
  const data = ws.data;
  const approvedTotal = data?.batches.filter((b) => !b.historical).reduce((s, b) => s + b.totalCents, 0) ?? 0;

  const preset = useMemo(() => {
    const q = new URLSearchParams(search);
    const report = q.get("report");
    const reseller = q.get("reseller");
    const promotion = q.get("promotion");
    if (!report && !reseller && !promotion) return null;
    const reportId = report?.replace(/^scan:/, "") ?? undefined;
    const entry = center.data?.uploads.find((u) => u.id === report || u.sourceId === reportId);
    return {
      reportId: entry?.sourceId ?? reportId,
      resellerId: reseller && /^\d+$/.test(reseller) ? Number(reseller) : undefined,
      promotionId: promotion ?? undefined,
    };
  }, [search, center.data]);

  return (
    <div className="flex h-full flex-col bg-muted/20">
      <header className="flex-none border-b bg-background px-6 py-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Scanback Claims</h1>
            <p className="text-sm text-muted-foreground">Claim per serial = reseller invoiced unit price ex GST minus GTM Buy Ex. One serial is payable once across all promotions.</p>
          </div>
          <div className="flex items-end gap-6">
            {data && (
              <dl className="flex gap-6 text-right">
                <div><dt className="text-[11px] uppercase tracking-wider text-slate-500">Active promotions</dt><dd className="font-mono text-lg font-semibold" data-testid="text-active-programs">{data.programs.filter((p) => !p.archived).length}</dd></div>
                <div><dt className="text-[11px] uppercase tracking-wider text-slate-500">Approved to date</dt><dd className="font-mono text-lg font-semibold" data-testid="text-approved-total">{formatCents(approvedTotal)}</dd></div>
              </dl>
            )}
            <Button variant="outline" size="sm" asChild data-testid="link-upload-center">
              <Link href="/upload"><UploadCloud className="mr-1.5 h-4 w-4" /> Upload Center</Link>
            </Button>
          </div>
        </div>
      </header>
      <div className="flex-1 overflow-auto px-4 py-6 md:px-8">
        {ws.isLoading ? (
          <div className="mx-auto w-full max-w-[1440px] space-y-3"><Skeleton className="h-10 w-96" /><Skeleton className="h-32 w-full" /><Skeleton className="h-64 w-full" /></div>
        ) : ws.isError || !data ? (
          <div className="mx-auto w-full max-w-[1440px] rounded-lg border border-rose-200 bg-rose-50 p-6 text-sm text-rose-800">
            <p className="font-semibold">Could not load scanback workspace</p>
            <p className="mt-1">{errorMessage(ws.error)}</p>
            <Button className="mt-3" size="sm" variant="outline" onClick={() => ws.refetch()} data-testid="button-retry-workspace">Retry</Button>
          </div>
        ) : (
          <Tabs value={tab} onValueChange={setTab} className="mx-auto w-full max-w-[1440px]">
            <TabsList className="flex-wrap h-auto">
              <TabsTrigger value="claims" data-testid="tab-claims-by-week">Claims by week</TabsTrigger>
              <TabsTrigger value="verify" data-testid="tab-verify">Verify Claims</TabsTrigger>
              <TabsTrigger value="programs" data-testid="tab-programs">Programs</TabsTrigger>
              <TabsTrigger value="history" data-testid="tab-history">Claims History</TabsTrigger>
              <TabsTrigger value="serials" data-testid="tab-serials">Serial lookup</TabsTrigger>
            </TabsList>
            <TabsContent value="claims" className="mt-4">
              <ClaimsByWeekPanel programs={data.programs} />
            </TabsContent>
            <TabsContent value="verify" className="mt-4">
              <VerifyPanel programs={data.programs} imports={data.imports} drafts={data.drafts} resellers={resellers} onApproved={() => undefined} preset={preset} onOpenSerial={openSerial} />
            </TabsContent>
            <TabsContent value="programs" className="mt-4 data-[state=inactive]:hidden" forceMount>
              {!partsQ.isLoading && (
                <ProgramsPanel programs={data.programs} resellers={resellers} parts={parts}
                  prices={center.data?.prices ?? []} uploads={center.data?.uploads ?? []}
                  stats={(data.programStats ?? []) as ProgramStat[]}
                  initialProgramId={preset?.promotionId} programUploadId={programUploadId} />
              )}
            </TabsContent>
            <TabsContent value="history" className="mt-4">
              <HistoryPanel batches={data.batches} resellers={resellers} />
            </TabsContent>
            <TabsContent value="serials" className="mt-4">
              <SerialLookup initialSerial={serialParam} onSearch={openSerial} />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  );
}
