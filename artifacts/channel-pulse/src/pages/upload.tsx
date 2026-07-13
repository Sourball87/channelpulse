import { useState, useRef } from "react";
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
  { value: "on_order", label: "On Order" },
  { value: "avg_cost", label: "Average Cost" }
];

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
  const [pendingReviews, setPendingReviews] = useState<any[]>([]);
  const [conflictInfo, setConflictInfo] = useState<ConflictState | null>(null);
  const [isConfirmingOverwrite, setIsConfirmingOverwrite] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; filename: string; status: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: uploads, isLoading: isLoadingUploads } = useGetUploads({ limit: 50 });
  const deleteUpload = useDeleteUpload();

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => setIsDragging(false);

  const processFiles = async (files: FileList | File[]) => {
    if (!files || files.length === 0) return;
    setIsUploading(true);
    const formData = new FormData();
    Array.from(files).forEach((file) => formData.append("files", file));

    try {
      const response = await fetch("/api/uploads", { method: "POST", body: formData });
      if (!response.ok) throw new Error("Upload failed");
      const result = await response.json();
      const needsReview = result.filter((r: any) => r.status === "needs_review");
      if (needsReview.length > 0) {
        setPendingReviews(prev => [...prev, ...needsReview]);
      }
      toast({
        title: "Upload processed",
        description: `${result.length} file(s) processed. ${needsReview.length} require review.`,
      });
      queryClient.invalidateQueries({ queryKey: getGetUploadsQueryKey() });
    } catch {
      toast({ title: "Upload failed", description: "Server error processing files.", variant: "destructive" });
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
          toast({ title: "Upload deleted", description: `"${deleteTarget.filename}" has been removed.` });
          queryClient.invalidateQueries({ queryKey: getGetUploadsQueryKey() });
          setDeleteTarget(null);
        },
        onError: () => {
          toast({ title: "Failed to delete upload", variant: "destructive" });
          setDeleteTarget(null);
        },
      }
    );
  };

  const doCommit = async (uploadId: number, resellerId: number, weekIso: string, mappings: any[], confirmOverwrite: boolean) => {
    const response = await fetch(`/api/uploads/${uploadId}/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reseller_id: resellerId, week_iso: weekIso, mappings, confirm_overwrite: confirmOverwrite }),
    });

    if (response.status === 409) {
      const data = await response.json();
      setConflictInfo({ uploadId, resellerId, weekIso, mappings, existingCount: data.existing_count, message: data.message });
      return false;
    }
    if (!response.ok) {
      toast({ title: "Failed to commit upload", variant: "destructive" });
      return false;
    }
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
    queryClient.invalidateQueries({ queryKey: getGetUploadsQueryKey() });
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
      queryClient.invalidateQueries({ queryKey: getGetUploadsQueryKey() });
    }
  };

  return (
    <div className="flex flex-col h-full bg-muted/20">
      <header className="flex-none bg-background border-b px-6 py-4">
        <h1 className="text-2xl font-semibold tracking-tight">Upload Center</h1>
        <p className="text-sm text-muted-foreground">Upload and process reseller inventory files</p>
      </header>

      <div className="flex-1 overflow-auto p-6 space-y-8">
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
              Requires Review ({pendingReviews.length})
            </h2>
            <div className="grid gap-6">
              {pendingReviews.map(review => (
                <ReviewCard
                  key={review.upload_id}
                  review={review}
                  onCommit={(commitData) => handleCommitReview(review, commitData)}
                  onDiscard={() => {
                    if (review.upload_id) handleDelete(review.upload_id);
                    setPendingReviews(prev => prev.filter(p => p.upload_id !== review.upload_id));
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
                      <TableCell>{upload.week_iso || "—"}</TableCell>
                      <TableCell>
                        {upload.status === "committed" && <Badge className="bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 border-emerald-500/20">Committed</Badge>}
                        {upload.status === "review" && <Badge variant="secondary" className="bg-amber-500/10 text-amber-700 border-amber-500/20">Review</Badge>}
                        {upload.status === "failed" && <Badge variant="destructive" className="bg-rose-500/10 text-rose-700 border-rose-500/20">Failed</Badge>}
                        {upload.status === "duplicate" && <Badge variant="outline">Duplicate</Badge>}
                        {upload.status === "pending" && <Badge variant="secondary">Pending</Badge>}
                      </TableCell>
                      <TableCell>{upload.rows_parsed?.toLocaleString() || "—"}</TableCell>
                      <TableCell className="text-right">
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
}: {
  review: any;
  onCommit: (data: CommitData) => void;
  onDiscard: () => void;
}) {
  const [mappings, setMappings] = useState<any[]>(review.mappings || []);
  const [resellerId, setResellerId] = useState<number | null>(review.detected_reseller_id ?? null);
  const [weekIso, setWeekIso] = useState<string>(review.detected_week_iso ?? "");
  const [rememberPattern, setRememberPattern] = useState(false);

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
    /^\d{4}-W\d{2}$/.test(weekIso) &&
    mappings.some(m => m.canonical_field === "part_no") &&
    mappings.some(m => m.canonical_field === "soh" || m.canonical_field === "sell_through_7d");

  return (
    <Card className="border-amber-200 dark:border-amber-900 shadow-sm overflow-hidden">
      <CardHeader className="bg-amber-50 dark:bg-amber-950/20 pb-4">
        <div className="flex justify-between items-start gap-4 flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Badge className="bg-amber-500 hover:bg-amber-600 text-white flex-shrink-0">Needs Review</Badge>
              <CardTitle className="text-lg flex items-center gap-2 truncate">
                <FileText className="h-5 w-5 text-amber-600 flex-shrink-0" />
                <span className="truncate">{review.filename}</span>
              </CardTitle>
            </div>
            <CardDescription className="text-amber-700 dark:text-amber-400">
              Column structure needs manual confirmation. Verify reseller and week below before committing.
            </CardDescription>
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
                {!resellerId ? "Select a reseller" : !weekIso ? "Enter a week (e.g. 2026-W27)" : "Map Part No and SOH/ST"}
              </span>
            )}
            <Button
              disabled={!readyToCommit}
              onClick={() => onCommit({ mappings, resellerId, weekIso, rememberPattern })}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              Save Mapping & Commit
            </Button>
          </div>
        </div>
      </CardFooter>
    </Card>
  );
}
