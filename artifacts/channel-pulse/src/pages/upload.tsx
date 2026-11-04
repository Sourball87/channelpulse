import { formatWeekLabel } from "@/lib/week-display";
import { useState, useRef, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetUploads, useDeleteUpload, useGetResellers, getGetUploadsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { UploadCloud, FileText, CheckCircle2, AlertCircle, XCircle, Clock, TriangleAlert, Trash2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { trackEvent } from "@/lib/analytics";
import { UploadDiagnostics } from "@/components/upload-diagnostics";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Extract a meaningful, reseller-distinct token from a filename for pattern matching. */
function extractFileToken(filename: string): string | null {
  const GENERIC = new Set(["samsung", "report", "weekly", "stock", "inventory", "data", "export", "soh", "sell"]);
  const parts = filename.replace(/\.[^.]+$/, "").split(/[._\-\s]+/);
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower.length <= 3) continue;                        // too short
    if (/^\d+$/.test(lower)) continue;                     // purely numeric
    if (/^(19|20)\d{2}/.test(lower) && lower.length <= 8) continue; // year/date prefix
    if (GENERIC.has(lower)) continue;                       // generic word
    return lower;
  }
  return null;
}

const CANONICAL_FIELDS = [
  { value: "ignore", label: "Ignore / Do not map" },
  { value: "part_no", label: "Part Number" },
  { value: "soh", label: "Stock on Hand (SOH)" },
  { value: "sell_through_7d", label: "Sell Through (ST)" },
  { value: "sold_mtd", label: "Sold MTD" },
  { value: "sold_14d", label: "Sold Last 14 Days" },
  { value: "sold_30d", label: "Sold Last 30 Days" },
  { value: "on_order", label: "On Order" },
  { value: "avg_cost", label: "Average Cost" }
];

function validWeek(value: string): boolean {
  const match = /^(\d{4})-W(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]), week = Number(match[2]);
  if (year < 1900 || year > 2100 || week < 1 || week > 53) return false;
  // December 28 is always in the final ISO week of its year.
  const d = new Date(Date.UTC(year, 11, 28));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const weeks = Math.ceil(((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
  return week <= weeks;
}

interface CommitData {
  mappings: any[];
  resellerId: number | null;
  weekIso: string;
  rememberPattern: boolean;
}

interface ConflictState {
  uploadId: number;
  resellerId: number;
  weekIso: string;
  mappings: any[];
  existingCount: number;
  message: string;
}

export default function UploadCenter() {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [batchWeek, setBatchWeek] = useState("");
  const [aiAssist, setAiAssist] = useState(true);
  const [recheckingId, setRecheckingId] = useState<number | null>(null);
  const [pendingReviews, setPendingReviews] = useState<any[]>([]);
  const [conflictInfo, setConflictInfo] = useState<ConflictState | null>(null);
  const [isConfirmingOverwrite, setIsConfirmingOverwrite] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; filename: string; status: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: uploads, isLoading: isLoadingUploads } = useGetUploads({ limit: 50 });
  const deleteUpload = useDeleteUpload();

  const reviewFromUpload = (u: any) => ({
    ...u, upload_id: u.id, status: "needs_review",
    detected_reseller_id: u.reseller_id ?? null,
    detected_week_iso: u.week_not_detected ? "" : u.week_iso ?? "",
    week_not_detected: u.week_not_detected ?? !u.week_iso,
    mappings: u.detected_mappings ?? [], diagnostics: u.diagnostics,
    candidates: u.candidates ?? [],
  });

  // Rehydrate review cards from DB on load (survives page refresh)
  useEffect(() => {
    if (!uploads) return;
    const reviewUploads = uploads.filter((u: any) => u.status === "review" && u.detected_mappings);
    setPendingReviews(prev => {
      return reviewUploads.map((u: any) => {
        const existing = prev.find(p => p.upload_id === u.id);
        return { ...existing, ...reviewFromUpload(u), review_revision: existing?.review_revision };
      });
    });
  }, [uploads]);

  const handleRecheck = async (id: number) => {
    if (batchWeek && !validWeek(batchWeek)) {
      toast({ title: "Invalid batch week", description: "Enter a valid ISO week or leave it blank.", variant: "destructive" });
      return;
    }
    setRecheckingId(id);
    trackEvent("upload_recheck_started", { ai_enabled: aiAssist, batch_week_selected: !!batchWeek });
    try {
      const response = await fetch(`/api/uploads/${id}/recheck`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batch_week: batchWeek || undefined, ai_assist: aiAssist }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Recheck failed");
      setPendingReviews(prev => prev.map(p => p.upload_id === id
        ? { ...reviewFromUpload(data), review_revision: Date.now() } : p));
      queryClient.invalidateQueries({ queryKey: getGetUploadsQueryKey() });
      toast({ title: "Recognition refreshed", description: "No analytics data was changed. Review the updated checks before committing." });
      trackEvent("upload_rechecked", { ai_enabled: aiAssist, ready: !!data.diagnostics?.ready_to_commit });
    } catch (err) {
      toast({ title: "Could not recheck", description: err instanceof Error ? err.message : "Please try again.", variant: "destructive" });
    } finally { setRecheckingId(null); }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => setIsDragging(false);

  const processFiles = async (files: FileList | File[]) => {
    if (!files || files.length === 0) return;
    if (files.length > 15 || (batchWeek && !validWeek(batchWeek))) {
      toast({ title: "Check upload options", description: "Choose up to 15 files and a valid batch week, or leave the week blank.", variant: "destructive" });
      return;
    }
    trackEvent("upload_started", { file_count: files.length });
    setIsUploading(true);
    const formData = new FormData();
    Array.from(files).forEach((file) => formData.append("files", file));
    if (batchWeek) formData.append("batch_week", batchWeek);
    formData.append("ai_assist", String(aiAssist));

    try {
      const response = await fetch("/api/uploads", { method: "POST", body: formData });
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.error ?? "Upload failed");
      }
      const result = await response.json();
      const needsReview = result.filter((r: any) => r.status === "needs_review");
      trackEvent("upload_processed", {
        file_count: result.length,
        review_count: needsReview.length,
        committed_count: result.filter((r: any) => r.status === "auto_committed").length,
        failed_count: result.filter((r: any) => r.status === "failed").length,
        duplicate_count: result.filter((r: any) => r.status === "duplicate").length,
      });
      if (needsReview.length > 0) {
        setPendingReviews(prev => [...prev, ...needsReview]);
      }
      toast({
        title: "Upload processed",
        description: `${result.filter((r: any) => r.status === "auto_committed").length} imported · ${needsReview.length} need confirmation · ${result.filter((r: any) => r.status === "duplicate").length} duplicates skipped · ${result.filter((r: any) => r.status === "failed").length} failed.`,
      });
      const failures = result.filter((r: any) => r.status === "failed");
      if (failures.length) toast({ title: "Some files could not be processed", description: failures.map((r: any) => `${r.filename}: ${r.error_message}`).join("; "), variant: "destructive" });
      queryClient.invalidateQueries();
    } catch (err) {
      trackEvent("upload_failed", { file_count: files.length });
      toast({ title: "Upload failed", description: err instanceof Error ? err.message : "Server error processing files.", variant: "destructive" });
    } finally {
      setIsUploading(false);
      setIsDragging(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    processFiles(e.dataTransfer.files);
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    deleteUpload.mutate(
      { id: deleteTarget.id },
      {
        onSuccess: () => {
          trackEvent("upload_deleted", { was_committed: deleteTarget.status === "committed" });
          toast({ title: "Upload deleted", description: `"${deleteTarget.filename}" has been removed.` });
          queryClient.invalidateQueries({ queryKey: getGetUploadsQueryKey() });
          setPendingReviews(prev => prev.filter(p => p.upload_id !== deleteTarget.id));
          setDeleteTarget(null);
        },
        onError: () => {
          trackEvent("upload_delete_failed", { was_committed: deleteTarget.status === "committed" });
          toast({ title: "Failed to delete upload", variant: "destructive" });
          setDeleteTarget(null);
        },
      }
    );
  };

  const doCommit = async (uploadId: number, resellerId: number, weekIso: string, mappings: any[], confirmOverwrite: boolean) => {
    trackEvent("upload_commit_started", { overwrite: confirmOverwrite, mapping_count: mappings.length });
    let response: Response;
    try {
      response = await fetch(`/api/uploads/${uploadId}/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reseller_id: resellerId, week_iso: weekIso, mappings, confirm_overwrite: confirmOverwrite }),
      });
    } catch {
      trackEvent("upload_commit_failed", { overwrite: confirmOverwrite, reason: "network" });
      toast({ title: "Failed to commit upload", variant: "destructive" });
      return false;
    }

    if (response.status === 409) {
      trackEvent("upload_commit_conflict", { overwrite: confirmOverwrite });
      const data = await response.json();
      if (data.error === "conflict" && Number.isInteger(data.existing_count)) {
        setConflictInfo({ uploadId, resellerId, weekIso, mappings, existingCount: data.existing_count, message: data.message });
      } else {
        toast({ title: "Upload changed", description: data.error ?? "Refresh and check this upload before continuing.", variant: "destructive" });
        queryClient.invalidateQueries({ queryKey: getGetUploadsQueryKey() });
      }
      return false;
    }
    if (!response.ok) {
      trackEvent("upload_commit_failed", { overwrite: confirmOverwrite, reason: "server", status_code: response.status });
      const details = await response.json().catch(() => null);
      toast({ title: "Failed to commit upload", description: details?.error ?? "Please check the mappings and try again.", variant: "destructive" });
      return false;
    }
    trackEvent("upload_committed", { overwrite: confirmOverwrite, mapping_count: mappings.length });
    return true;
  };

  const handleCommitReview = async (review: any, commitData: CommitData) => {
    const { mappings, resellerId, weekIso, rememberPattern } = commitData;
    if (!resellerId || !weekIso) {
      toast({ title: "Missing metadata", description: "Select a reseller and enter a week to commit.", variant: "destructive" });
      return;
    }

    const ok = await doCommit(review.upload_id, resellerId, weekIso, mappings, false);
    if (!ok) return;

    // Save filename pattern if requested — append to existing patterns, never replace
    if (rememberPattern && review.filename) {
      const token = extractFileToken(review.filename);
      if (token) {
        try {
          // Fetch current patterns so we can merge rather than overwrite
          const resellerResp = await fetch("/api/resellers");
          const allRes: any[] = resellerResp.ok ? await resellerResp.json() : [];
          const currentReseller = allRes.find((r: any) => r.id === resellerId);
          const currentPatterns: string[] = currentReseller?.filename_patterns ?? [];
          if (!currentPatterns.includes(token)) {
            await fetch(`/api/resellers/${resellerId}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ filename_patterns: [...currentPatterns, token] }),
            });
          }
        } catch {
          // non-fatal — don't block the commit
        }
      }
    }

    toast({ title: "Upload committed successfully" });
    setPendingReviews(prev => prev.filter(p => p.upload_id !== review.upload_id));
    queryClient.invalidateQueries();
  };

  const handleConfirmOverwrite = async () => {
    if (!conflictInfo) return;
    setIsConfirmingOverwrite(true);
    const { uploadId, resellerId, weekIso, mappings } = conflictInfo;
    setConflictInfo(null);
    const ok = await doCommit(uploadId, resellerId, weekIso, mappings, true);
    setIsConfirmingOverwrite(false);
    if (ok) {
      toast({ title: "Upload committed — existing data replaced" });
      setPendingReviews(prev => prev.filter(p => p.upload_id !== uploadId));
      queryClient.invalidateQueries();
    }
  };

  return (
    <div className="flex flex-col h-full bg-muted/20">
      <header className="flex-none bg-background border-b px-6 py-4">
        <h1 className="text-2xl font-semibold tracking-tight">Upload Center</h1>
        <p className="text-sm text-muted-foreground">Upload and process reseller inventory files</p>
      </header>

      <div className="flex-1 overflow-auto p-6 space-y-8">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Upload options</CardTitle>
            <CardDescription>Known reports are recognised without AI. These options also apply when you recheck a pending file.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="max-w-md space-y-2">
              <Label htmlFor="batch-week">Reporting week for undated files (optional)</Label>
              <Input id="batch-week" placeholder="2026-W27" value={batchWeek}
                className="max-w-[180px] font-mono" aria-invalid={!!batchWeek && !validWeek(batchWeek)}
                onChange={e => setBatchWeek(e.target.value.trim())} disabled={isUploading || recheckingId !== null} />
              <p className="text-xs text-muted-foreground">
                Applies only when the report has no detected week. Dated reports keep their own week;
                split different weeks into separate batches. Copy numbers such as (1) are not dates.
              </p>
              {!!batchWeek && !validWeek(batchWeek) && <p className="text-sm text-destructive">Enter a valid ISO week, for example 2026-W27.</p>}
              {!!batchWeek && validWeek(batchWeek) && <p className="text-sm text-muted-foreground">{formatWeekLabel(batchWeek)} (Mon–Sun)</p>}
            </div>
            <div className="flex gap-3 items-start">
              <Checkbox id="ai-assist" checked={aiAssist} onCheckedChange={v => setAiAssist(v === true)}
                disabled={isUploading || recheckingId !== null} />
              <div className="space-y-1">
                <Label htmlFor="ai-assist" className="cursor-pointer">Use AI for unresolved recognition</Label>
                <p className="text-xs text-muted-foreground max-w-2xl">
                  Enabled by default for unresolved reports; uncheck to turn it off. When needed, sends filename, sheet/column labels and a few short text samples
                  (which may include reseller names, reporting dates and product identifiers) to OpenAI through Replit AI Integrations.
                  Stock, sales and cost columns and full files are not sent. Usage is billed to your Replit credits.
                  AI suggestions require your confirmation and cannot approve overwrites or invent missing information.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        {/* Upload Zone */}
        <div
          className={`border-2 border-dashed rounded-xl p-12 text-center transition-all ${
            isDragging ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-muted/50"
          }`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <input
            type="file"
            ref={fileInputRef}
            className="hidden"
            accept=".xlsx,.xls,.csv"
            multiple
            onChange={(e) => e.target.files && processFiles(e.target.files)}
          />
          <div className="mx-auto w-16 h-16 bg-muted rounded-full flex items-center justify-center mb-4">
            <UploadCloud className={`h-8 w-8 ${isDragging ? "text-primary" : "text-muted-foreground"}`} />
          </div>
          <h3 className="text-lg font-semibold mb-2">Drag and drop files here</h3>
          <p className="text-muted-foreground mb-6 max-w-sm mx-auto">
            Supports Excel (.xlsx, .xls) and CSV files. Upload up to 15 files at once.
          </p>
          <Button onClick={() => fileInputRef.current?.click()} disabled={isUploading}>
            {isUploading ? "Processing..." : "Select Files"}
          </Button>
        </div>

        {/* Pending Reviews */}
        {pendingReviews.length > 0 && (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-amber-500" />
              Pending confirmation ({pendingReviews.length})
            </h2>
            <div className="grid gap-6">
              {pendingReviews.map(review => (
                <ReviewCard
                  key={`${review.upload_id}-${review.review_revision ?? "initial"}`}
                  review={review}
                  onRecheck={() => handleRecheck(review.upload_id)}
                  rechecking={recheckingId !== null}
                  onCommit={(commitData) => handleCommitReview(review, commitData)}
                  onDiscard={() => {
                    if (review.upload_id) setDeleteTarget({ id: review.upload_id, filename: review.filename, status: "review" });
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {/* Upload History */}
        <div className="space-y-4">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Clock className="h-5 w-5" /> Upload History
          </h2>
          <Card className="shadow-xs overflow-hidden">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead>Reseller</TableHead>
                  <TableHead>Week</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Rows</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoadingUploads ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                      <TableCell><Skeleton className="h-6 w-20" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-12" /></TableCell>
                      <TableCell></TableCell>
                    </TableRow>
                  ))
                ) : !uploads || uploads.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                      No recent uploads found.
                    </TableCell>
                  </TableRow>
                ) : (
                  uploads.map((upload) => (
                    <TableRow key={upload.id}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                          <span className="truncate max-w-[200px]">{upload.filename}</span>
                        </div>
                      </TableCell>
                      <TableCell>{upload.reseller_name || "Unknown"}</TableCell>
                      <TableCell>{upload.week_iso ? formatWeekLabel(upload.week_iso) : "—"}</TableCell>
                      <TableCell>
                        {upload.status === "committed" && <Badge className="bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 border-emerald-500/20">Committed</Badge>}
                        {upload.status === "review" && <Badge variant="secondary" className="bg-amber-500/10 text-amber-700 border-amber-500/20">{upload.diagnostics?.ready_to_commit ? "Ready" : "Review"}</Badge>}
                        {upload.status === "failed" && <Badge variant="destructive" className="bg-rose-500/10 text-rose-700 border-rose-500/20">Failed</Badge>}
                        {upload.status === "duplicate" && <Badge variant="outline">Duplicate</Badge>}
                        {upload.status === "pending" && <Badge variant="secondary">Pending</Badge>}
                        {upload.status === "review" && <UploadDiagnostics diagnostics={upload.diagnostics} compact />}
                      </TableCell>
                      <TableCell>{upload.rows_parsed?.toLocaleString() || "—"}</TableCell>
                      <TableCell className="text-right">
                        {upload.status === "review" && (
                          <Button variant="outline" size="sm" className="mr-2"
                            disabled={recheckingId !== null || isUploading}
                            onClick={() => handleRecheck(upload.id)}>
                            {recheckingId === upload.id ? "Rechecking…" : "Recheck"}
                          </Button>
                        )}
                        {upload.status === "review" && (
                          <Button variant="outline" size="sm" className="mr-2"
                            onClick={() => document.getElementById(`review-${upload.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                            Review
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-rose-600 hover:bg-rose-50"
                          onClick={() => setDeleteTarget({ id: upload.id, filename: upload.filename, status: upload.status })}
                          disabled={deleteUpload.isPending}
                          title="Delete upload"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="h-5 w-5 text-rose-500" />
              Delete Upload?
            </DialogTitle>
            <DialogDescription>
              This will permanently remove <strong className="text-foreground">{deleteTarget?.filename}</strong> from the database.
              {deleteTarget?.status === "committed" && (
                <span className="block mt-1 text-rose-600 font-medium">All inventory snapshots from this file will also be deleted.</span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleteUpload.isPending}>
              {deleteUpload.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Conflict overwrite dialog */}
      <Dialog open={!!conflictInfo} onOpenChange={(open) => { if (!open) setConflictInfo(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TriangleAlert className="h-5 w-5 text-amber-500" />
              Overwrite Existing Data?
            </DialogTitle>
            <DialogDescription>
              {conflictInfo?.message}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will replace <strong>{conflictInfo?.existingCount}</strong> existing snapshot(s) for week <strong>{conflictInfo?.weekIso}</strong>.
            Other parts from this reseller for the same week are not affected.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConflictInfo(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleConfirmOverwrite} disabled={isConfirmingOverwrite}>
              {isConfirmingOverwrite ? "Committing…" : "Yes, replace data"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ReviewCard({
  review,
  onCommit,
  onDiscard,
  onRecheck,
  rechecking,
}: {
  review: any;
  onCommit: (data: CommitData) => Promise<void>;
  onDiscard: () => void;
  onRecheck: () => Promise<void>;
  rechecking: boolean;
}) {
  const [mappings, setMappings] = useState<any[]>(review.mappings || []);
  const [resellerId, setResellerId] = useState<number | null>(review.detected_reseller_id ?? null);
  const [weekIso, setWeekIso] = useState<string>(review.detected_week_iso ?? "");
  const [rememberPattern, setRememberPattern] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);

  const { data: allResellers } = useGetResellers();

  const updateMapping = (sourceCol: string, canonicalField: string) => {
    setMappings(prev => prev.map(m =>
      m.source_col === sourceCol
        ? { ...m, canonical_field: canonicalField === "ignore" ? null : canonicalField }
        : m
    ));
  };

  const weekNotDetected = !!review.week_not_detected;
  const readyToCommit =
    !!resellerId &&
    !!weekIso &&
    validWeek(weekIso) &&
    mappings.some(m => m.canonical_field === "part_no") &&
    mappings.some(m => m.canonical_field === "soh") &&
    mappings.some(m => m.canonical_field === "sell_through_7d") &&
    new Set(mappings.map(m => m.canonical_field).filter(Boolean)).size ===
      mappings.filter(m => m.canonical_field).length;

  return (
    <Card id={`review-${review.upload_id}`} className="border-amber-200 dark:border-amber-900 shadow-sm overflow-hidden scroll-mt-4">
      <CardHeader className="bg-amber-50 dark:bg-amber-950/20 pb-4">
        <div className="flex justify-between items-start gap-4 flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Badge className="bg-amber-500 hover:bg-amber-600 text-white flex-shrink-0">{review.diagnostics?.ready_to_commit ? "Ready to commit" : "Needs Review"}</Badge>
              <CardTitle className="text-lg flex items-center gap-2 truncate">
                <FileText className="h-5 w-5 text-amber-600 flex-shrink-0" />
                <span className="truncate">{review.filename}</span>
              </CardTitle>
            </div>
            <CardDescription className="text-amber-700 dark:text-amber-400">
              Pending only—not included in analytics until committed. Verify reseller, reporting week and column mappings.
            </CardDescription>
            {review.detection_reasoning && <p className="mt-2 text-xs text-muted-foreground">{review.detection_reasoning}</p>}
            <UploadDiagnostics diagnostics={review.diagnostics} />
            <Button type="button" variant="outline" size="sm" className="mt-3"
              disabled={rechecking || isCommitting} onClick={onRecheck}>
              {rechecking ? "Rechecking…" : "Recheck recognition"}
            </Button>
            <p className="mt-1 text-xs text-muted-foreground">Recheck refreshes saved recognition only. It resets unsaved edits in this card and never imports data.</p>
            {!review.detected_reseller_id && review.candidates?.length > 0 && (
              <p className="mt-2 text-sm text-amber-800">
                Possible resellers: {review.candidates.map((c: any) => c.name).join(", ")}. Select the correct one.
              </p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              {review.rows_parsed ?? 0} product rows · {review.rows_flagged ?? 0} flagged for checking
            </p>
            {review.rows_flagged > 0 && (
              <p className="mt-1 text-sm text-amber-800">Check the source for unusual SKUs, invalid numbers or negative stock. Valid negative stock is preserved; invalid numbers must be corrected.</p>
            )}
          </div>

          {/* Editable metadata */}
          <div className="flex gap-3 flex-wrap">
            {/* Reseller picker */}
            <div className="min-w-[180px]">
              <p className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground mb-1">Reseller</p>
              <Select
                value={resellerId ? String(resellerId) : ""}
                onValueChange={(v) => setResellerId(v ? Number(v) : null)}
              >
                <SelectTrigger className={`h-8 text-sm ${!resellerId ? "border-amber-400" : ""}`}>
                  <SelectValue placeholder="Select reseller…" />
                </SelectTrigger>
                <SelectContent>
                  {(allResellers ?? []).map((r: any) => (
                    <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Week picker */}
            <div className="min-w-[140px]">
              <p className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground mb-1">
                Week {weekNotDetected && <span className="text-amber-600 font-semibold">⚠ not detected</span>}
              </p>
              <Input
                className={`h-8 text-sm font-mono ${weekNotDetected && !weekIso ? "border-amber-400" : ""}`}
                placeholder="2026-W27"
                value={weekIso}
                onChange={(e) => setWeekIso(e.target.value.trim())}
              />
              {weekIso && !validWeek(weekIso) && <p className="text-xs text-destructive mt-1">Enter a valid ISO week.</p>}
              {weekIso && validWeek(weekIso) && <p className="text-xs text-muted-foreground mt-1">{formatWeekLabel(weekIso)} (Mon–Sun)</p>}
              {review.detected_week_iso && weekIso !== review.detected_week_iso && (
                <p className="text-xs text-amber-700 mt-1 max-w-[200px]">
                  You are overriding {formatWeekLabel(review.detected_week_iso)}. Check the reporting period before committing.
                </p>
              )}
            </div>
          </div>
        </div>

        {weekNotDetected && (
          <div className="mt-3 flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400 bg-amber-100/60 dark:bg-amber-900/30 rounded-md px-3 py-2">
            <TriangleAlert className="h-4 w-4 flex-shrink-0" />
            Week could not be detected from the filename — please confirm the correct ISO week above before committing.
          </div>
        )}
      </CardHeader>

      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-1/3">Source Column</TableHead>
                <TableHead className="w-1/3">Map To Standard Field</TableHead>
                <TableHead>Preview (First row)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {mappings.map((mapping: any, idx: number) => {
                const previewValue =
                  review.preview_rows?.length > 0
                    ? review.preview_rows[0][mapping.source_col]
                    : mapping.sample_values?.[0] || "—";
                return (
                  <TableRow key={idx}>
                    <TableCell className="font-medium bg-muted/20">{mapping.source_col}</TableCell>
                    <TableCell>
                      <Select
                        value={mapping.canonical_field || "ignore"}
                        onValueChange={(val) => updateMapping(mapping.source_col, val)}
                      >
                        <SelectTrigger className={mapping.canonical_field ? "border-primary/50 bg-primary/5" : ""}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CANONICAL_FIELDS.map(f => (
                            <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="text-muted-foreground font-mono text-xs">
                      {String(previewValue ?? "—")}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>

      <CardFooter className="bg-muted/20 p-4 border-t flex flex-col gap-3">
        {/* Remember pattern */}
        {resellerId && (
          <div className="flex items-center gap-2 w-full">
            <Checkbox
              id={`remember-${review.upload_id}`}
              checked={rememberPattern}
              onCheckedChange={(v) => setRememberPattern(!!v)}
            />
            <Label htmlFor={`remember-${review.upload_id}`} className="text-sm text-muted-foreground cursor-pointer">
              Remember this filename pattern for{" "}
              <span className="font-medium text-foreground">
                {allResellers?.find((r: any) => r.id === resellerId)?.name ?? "this reseller"}
              </span>
            </Label>
          </div>
        )}

        <div className="flex justify-between items-center w-full">
          <Button variant="ghost" className="text-rose-600 hover:text-rose-700 hover:bg-rose-50" onClick={onDiscard}>
            Discard File
          </Button>
          <div className="flex items-center gap-3">
            {!readyToCommit && (
              <span className="text-sm text-amber-600">
                {!resellerId ? "Select a reseller" : !weekIso ? "Enter a week (e.g. 2026-W27)" : "Map Part No, SOH and 7-day Sales once each"}
              </span>
            )}
            <Button
              disabled={!readyToCommit || isCommitting || rechecking}
              onClick={async () => {
                setIsCommitting(true);
                try { await onCommit({ mappings, resellerId, weekIso, rememberPattern }); }
                finally { setIsCommitting(false); }
              }}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              {isCommitting ? "Committing…" : "Confirm & Commit"}
            </Button>
          </div>
        </div>
      </CardFooter>
    </Card>
  );
}
