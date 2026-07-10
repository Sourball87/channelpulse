import { useState, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetUploads, useDeleteUpload, useCommitUpload, getGetUploadsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { UploadCloud, FileText, CheckCircle2, AlertCircle, XCircle, ChevronRight, Clock, ArrowLeftRight } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const CANONICAL_FIELDS = [
  { value: "ignore", label: "Ignore / Do not map" },
  { value: "part_no", label: "Part Number" },
  { value: "soh", label: "Stock on Hand (SOH)" },
  { value: "st", label: "Sell Through (ST)" },
  { value: "sold_mtd", label: "Sold MTD" },
  { value: "on_order", label: "On Order" },
  { value: "avg_cost", label: "Average Cost" }
];

export default function UploadCenter() {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [pendingReviews, setPendingReviews] = useState<any[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: uploads, isLoading: isLoadingUploads } = useGetUploads({ limit: 50 });
  const deleteUpload = useDeleteUpload();
  const commitUpload = useCommitUpload();

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const processFiles = async (files: FileList | File[]) => {
    if (!files || files.length === 0) return;
    
    setIsUploading(true);
    const formData = new FormData();
    Array.from(files).forEach((file) => {
      formData.append("files", file);
    });

    try {
      const response = await fetch("/api/uploads", {
        method: "POST",
        body: formData,
      });
      
      if (!response.ok) throw new Error("Upload failed");
      
      const result = await response.json();
      
      // Separate auto-committed from needs-review
      const needsReview = result.filter((r: any) => r.status === "needs_review");
      
      if (needsReview.length > 0) {
        setPendingReviews(prev => [...prev, ...needsReview]);
      }
      
      toast({
        title: "Upload processed",
        description: `Processed ${result.length} files. ${needsReview.length} require manual review.`,
      });
      
      queryClient.invalidateQueries({ queryKey: getGetUploadsQueryKey() });
    } catch (error) {
      console.error(error);
      toast({
        title: "Upload failed",
        description: "There was an error communicating with the server.",
        variant: "destructive"
      });
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

  const handleDelete = (id: number) => {
    deleteUpload.mutate(
      { id },
      {
        onSuccess: () => {
          toast({ title: "Upload rolled back successfully" });
          queryClient.invalidateQueries({ queryKey: getGetUploadsQueryKey() });
        },
        onError: () => {
          toast({ title: "Failed to roll back upload", variant: "destructive" });
        }
      }
    );
  };

  const handleCommitReview = (review: any, finalMappings: any[]) => {
    if (!review.detected_reseller_id || !review.detected_week_iso) {
      toast({ title: "Missing metadata", description: "Reseller and Week must be detected to commit.", variant: "destructive" });
      return;
    }

    commitUpload.mutate(
      { 
        id: review.upload_id, 
        data: {
          reseller_id: review.detected_reseller_id,
          week_iso: review.detected_week_iso,
          mappings: finalMappings,
          confirm_overwrite: true
        }
      },
      {
        onSuccess: () => {
          toast({ title: "Upload committed successfully" });
          setPendingReviews(prev => prev.filter(p => p.upload_id !== review.upload_id));
          queryClient.invalidateQueries({ queryKey: getGetUploadsQueryKey() });
        },
        onError: () => {
          toast({ title: "Failed to commit upload", variant: "destructive" });
        }
      }
    );
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
            The system will automatically detect the reseller and week.
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
                  onCommit={(mappings) => handleCommitReview(review, mappings)}
                  onDiscard={() => {
                    handleDelete(review.upload_id);
                    setPendingReviews(prev => prev.filter(p => p.upload_id !== review.upload_id));
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {/* History Table */}
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
                      <TableCell className="font-medium flex items-center gap-2">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        {upload.filename}
                      </TableCell>
                      <TableCell>{upload.reseller_name || "Unknown"}</TableCell>
                      <TableCell>{upload.week_iso || "—"}</TableCell>
                      <TableCell>
                        {upload.status === 'committed' && <Badge className="bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 border-emerald-500/20">Committed</Badge>}
                        {upload.status === 'review' && <Badge variant="secondary" className="bg-amber-500/10 text-amber-700 border-amber-500/20 hover:bg-amber-500/20">Review</Badge>}
                        {upload.status === 'failed' && <Badge variant="destructive" className="bg-rose-500/10 text-rose-700 hover:bg-rose-500/20 border-rose-500/20">Failed</Badge>}
                        {upload.status === 'duplicate' && <Badge variant="outline">Duplicate</Badge>}
                        {upload.status === 'pending' && <Badge variant="secondary">Pending</Badge>}
                      </TableCell>
                      <TableCell>{upload.rows_parsed?.toLocaleString() || "—"}</TableCell>
                      <TableCell className="text-right">
                        {(upload.status === 'committed' || upload.status === 'review') && (
                          <Button 
                            variant="ghost" 
                            size="sm" 
                            className="text-rose-600 hover:text-rose-700 hover:bg-rose-50"
                            onClick={() => handleDelete(upload.id)}
                            disabled={deleteUpload.isPending}
                          >
                            Rollback
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </div>
      </div>
    </div>
  );
}

function ReviewCard({ review, onCommit, onDiscard }: { review: any, onCommit: (mappings: any[]) => void, onDiscard: () => void }) {
  // Local state for mappings to allow editing
  const [mappings, setMappings] = useState<any[]>(review.mappings || []);

  const updateMapping = (sourceCol: string, canonicalField: string) => {
    setMappings(prev => prev.map(m => 
      m.source_col === sourceCol 
        ? { ...m, canonical_field: canonicalField === 'ignore' ? null : canonicalField } 
        : m
    ));
  };

  const readyToCommit = mappings.some(m => m.canonical_field === 'part_no') && 
                        mappings.some(m => m.canonical_field === 'soh' || m.canonical_field === 'st');

  return (
    <Card className="border-amber-200 dark:border-amber-900 shadow-sm overflow-hidden">
      <CardHeader className="bg-amber-50 dark:bg-amber-950/20 pb-4">
        <div className="flex justify-between items-start">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Badge className="bg-amber-500 hover:bg-amber-600 text-white">Needs Review</Badge>
              <CardTitle className="text-lg flex items-center gap-2">
                <FileText className="h-5 w-5 text-amber-600" />
                {review.filename}
              </CardTitle>
            </div>
            <CardDescription className="text-amber-700 dark:text-amber-400">
              The column structure in this file doesn't match known patterns. Please map the columns manually.
            </CardDescription>
          </div>
          <div className="flex gap-4 text-sm bg-white dark:bg-card px-4 py-2 rounded-md border shadow-xs">
            <div>
              <span className="text-muted-foreground block text-[10px] uppercase font-bold tracking-wider">Detected Reseller</span>
              <span className="font-medium">{review.detected_reseller_name || "Unknown"}</span>
            </div>
            <div className="border-l pl-4">
              <span className="text-muted-foreground block text-[10px] uppercase font-bold tracking-wider">Detected Week</span>
              <span className="font-medium">{review.detected_week_iso || "Unknown"}</span>
            </div>
          </div>
        </div>
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
                const previewValue = review.preview_rows && review.preview_rows.length > 0 
                  ? review.preview_rows[0][mapping.source_col] 
                  : mapping.sample_values?.[0] || "—";
                  
                return (
                  <TableRow key={idx}>
                    <TableCell className="font-medium bg-muted/20">
                      {mapping.source_col}
                    </TableCell>
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
                      {String(previewValue)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
      
      <CardFooter className="bg-muted/20 p-4 border-t flex justify-between">
        <Button variant="ghost" className="text-rose-600 hover:text-rose-700 hover:bg-rose-50" onClick={onDiscard}>
          Discard File
        </Button>
        <div className="flex items-center gap-3">
          {!readyToCommit && (
            <span className="text-sm text-amber-600">Map at least Part No and SOH/ST to continue</span>
          )}
          <Button 
            disabled={!readyToCommit}
            onClick={() => onCommit(mappings)}
            className="bg-amber-600 hover:bg-amber-700 text-white"
          >
            Save Mapping & Commit
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}
