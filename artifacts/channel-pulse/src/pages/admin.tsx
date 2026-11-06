import { customerLabel, isMaskedCustomer } from "@/lib/customer-display";
import { useState, useMemo } from "react";
import { 
  useGetResellers, 
  useCreateReseller, 
  useUpdateReseller, 
  useDeleteReseller,
  useGetParts,
  useCreatePart,
  useUpdatePart,
  useGetColumnMappings,
  useDeleteColumnMapping,
  getGetResellersQueryKey,
  getGetPartsQueryKey,
  getGetColumnMappingsQueryKey
} from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Plus, Settings2, Trash2, Edit2, AlertCircle, Download, RefreshCw } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

export default function AdminSettings() {
  return (
    <div className="flex flex-col h-full bg-muted/20">
      <header className="flex-none bg-background border-b px-6 py-4">
        <h1 className="text-2xl font-semibold tracking-tight">System Settings</h1>
        <p className="text-sm text-muted-foreground">Manage resellers, parts catalog, and parser rules</p>
      </header>

      <div className="flex-1 overflow-auto p-6">
        <Tabs defaultValue="resellers" className="w-full h-full flex flex-col">
          <TabsList className="grid w-full max-w-xl grid-cols-4">
            <TabsTrigger value="resellers" className="flex-1">Resellers</TabsTrigger>
            <TabsTrigger value="parts" className="flex-1">Parts Master</TabsTrigger>
            <TabsTrigger value="mappings" className="flex-1">Column Mappings</TabsTrigger>
            <TabsTrigger value="export" className="flex-1">Export</TabsTrigger>
          </TabsList>
          
          <div className="mt-4 flex-1">
            <TabsContent value="resellers" className="m-0 h-full">
              <ResellersTab />
            </TabsContent>
            <TabsContent value="parts" className="m-0 h-full">
              <PartsTab />
            </TabsContent>
            <TabsContent value="mappings" className="m-0 h-full">
              <MappingsTab />
            </TabsContent>
            <TabsContent value="export" className="m-0 h-full">
              <ExportTab />
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </div>
  );
}

interface WeeklyExport { name: string; createdAt: string; size: number }
function ExportTab() {
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["scanback-weekly-exports"],
    queryFn: async (): Promise<WeeklyExport[]> => {
      const response = await fetch("/api/scanback/exports/weekly");
      if (!response.ok) throw new Error("Weekly exports are unavailable.");
      return response.json() as Promise<WeeklyExport[]>;
    },
    staleTime: 60_000,
  });
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Complete scanback export</CardTitle>
          <CardDescription>One workbook containing programs, approved claim batches and serials, credit resolutions, and the reseller list.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild className="gap-2" data-testid="button-export-scanback-workbook">
            <a href="/api/scanback/export"><Download className="h-4 w-4" /> Download Excel workbook</a>
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle>Automatic weekly exports</CardTitle>
            <CardDescription>Saved privately to App Storage. The 12 most recent weekly workbooks are kept.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching} aria-label="Refresh weekly exports">
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {isLoading ? <p className="text-sm text-muted-foreground">Loading weekly exports…</p> :
            isError ? <p role="alert" className="text-sm text-destructive">Weekly exports could not be loaded. Refresh to try again.</p> :
              !data?.length ? <p className="text-sm text-muted-foreground">No weekly export has been saved yet.</p> :
                data.map(item => (
                  <div key={item.name} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
                    <div>
                      <p className="font-mono text-xs">{item.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {item.createdAt ? new Date(item.createdAt).toLocaleString() : "Date unavailable"} · {(item.size / 1024).toFixed(0)} KB
                      </p>
                    </div>
                    <Button asChild variant="outline" size="sm">
                      <a href={`/api/scanback/exports/weekly/${encodeURIComponent(item.name)}`}><Download className="mr-1 h-3.5 w-3.5" />Download</a>
                    </Button>
                  </div>
                ))}
        </CardContent>
      </Card>
    </div>
  );
}

function ResellersTab() {
  const { data: resellers, isLoading } = useGetResellers();
  const [editingReseller, setEditingReseller] = useState<any>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  
  return (
    <Card className="h-full flex flex-col shadow-xs">
      <CardHeader className="flex flex-row items-center justify-between border-b">
        <div>
          <CardTitle>Reseller Configuration</CardTitle>
          <CardDescription>Manage channel partners, their file patterns and which weekly reports the Upload Center expects. Files are uploaded only in the Upload Center.</CardDescription>
        </div>
        <ResellerDialog 
          open={isDialogOpen} 
          onOpenChange={setIsDialogOpen} 
          reseller={editingReseller} 
          onClose={() => setEditingReseller(null)} 
        />
      </CardHeader>
      <CardContent className="flex-1 p-0 overflow-auto">
        <Table>
          <TableHeader className="bg-muted/50 sticky top-0">
            <TableRow>
              <TableHead className="w-12"></TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Expected Files/Wk</TableHead>
              <TableHead>Source Matching</TableHead>
              <TableHead>Sends SOH</TableHead>
              <TableHead>Sends serial reports</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={8}><Skeleton className="h-8 w-full" /></TableCell></TableRow>
            ) : resellers?.map((r) => (
              <TableRow key={r.id} className={r.active === false ? "opacity-60" : ""}>
                <TableCell>
                  <div className={`h-2 w-2 rounded-full ${r.active !== false ? 'bg-emerald-500' : 'bg-muted-foreground'}`} />
                </TableCell>
                <TableCell className="font-mono text-xs font-semibold">{customerLabel(r.code)}</TableCell>
                <TableCell className="font-medium">{r.name}</TableCell>
                <TableCell>{r.expected_weekly_files || 0}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant="secondary" className="text-[10px]">
                      {r.filename_patterns?.length ?? 0} saved rules
                    </Badge>
                  </div>
                </TableCell>
                <TableCell><FlagSwitch reseller={r} field="sends_soh" /></TableCell>
                <TableCell><FlagSwitch reseller={r} field="sends_serial_reports" /></TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => { setEditingReseller(r); setIsDialogOpen(true); }}>
                    <Edit2 className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

type ResellerFlag = "sends_soh" | "sends_serial_reports";
export function resellerFlag(r: unknown, field: ResellerFlag): boolean {
  const v = (r as Record<string, unknown>)[field];
  return typeof v === "boolean" ? v : field === "sends_soh";
}

function FlagSwitch({ reseller, field }: { reseller: { id: number; code: string }; field: ResellerFlag }) {
  const update = useUpdateReseller();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const checked = resellerFlag(reseller, field);
  return (
    <Switch
      checked={checked}
      disabled={update.isPending}
      aria-label={`${field === "sends_soh" ? "Sends SOH" : "Sends serial reports"} for ${customerLabel(reseller.code)}`}
      data-testid={`switch-${field}-${reseller.id}`}
      onCheckedChange={(c) => update.mutate(
        { id: reseller.id, data: { [field]: c } as Record<string, boolean> },
        {
          onSuccess: () => { queryClient.invalidateQueries(); },
          onError: () => toast({ title: "Could not update reseller", variant: "destructive" }),
        },
      )}
    />
  );
}

function ResellerDialog({ open, onOpenChange, reseller, onClose }: { open: boolean, onOpenChange: (open: boolean) => void, reseller: any, onClose: () => void }) {
  const maskedCustomer = !!reseller && isMaskedCustomer(reseller.code);
  const [formData, setFormData] = useState({
    code: "", name: "", expected_weekly_files: 1, filename_patterns: "", active: true
  });
  
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const createReseller = useCreateReseller();
  const updateReseller = useUpdateReseller();
  
  // Sync form data when dialog opens
  useMemo(() => {
    if (open) {
      if (reseller) {
        setFormData({
          code: customerLabel(reseller.code),
          name: maskedCustomer ? customerLabel(reseller.code) : reseller.name,
          expected_weekly_files: reseller.expected_weekly_files || 1,
          filename_patterns: maskedCustomer ? "" : reseller.filename_patterns?.join(", ") || "",
          active: reseller.active !== false
        });
      } else {
        setFormData({ code: "", name: "", expected_weekly_files: 1, filename_patterns: "", active: true });
      }
    }
  }, [open, reseller]);

  const handleSubmit = () => {
    const data = {
      ...(maskedCustomer ? {} : { code: formData.code, name: formData.name }),
      expected_weekly_files: Number(formData.expected_weekly_files),
      ...(maskedCustomer && !formData.filename_patterns.trim() ? {} : {
        filename_patterns: formData.filename_patterns.split(",").map(s => s.trim()).filter(Boolean),
      }),
      active: formData.active
    };
    
    if (reseller) {
      updateReseller.mutate({ id: reseller.id, data }, {
        onSuccess: () => {
          toast({ title: "Reseller updated" });
          queryClient.invalidateQueries({ queryKey: getGetResellersQueryKey() });
          onOpenChange(false);
          onClose();
        }
      });
    } else {
      createReseller.mutate({ data: { ...data, code: formData.code, name: formData.name } }, {
        onSuccess: () => {
          toast({ title: "Reseller created" });
          queryClient.invalidateQueries({ queryKey: getGetResellersQueryKey() });
          onOpenChange(false);
          onClose();
        }
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) onClose(); }}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-2"><Plus className="h-4 w-4" /> Add Reseller</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{reseller ? "Edit Reseller" : "New Reseller"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid grid-cols-4 items-center gap-4">
            <label className="text-right text-sm font-medium">Code</label>
            <Input readOnly={maskedCustomer} className="col-span-3 font-mono" value={formData.code} onChange={e => setFormData({...formData, code: e.target.value.toUpperCase()})} />
          </div>
          <div className="grid grid-cols-4 items-center gap-4">
            <label className="text-right text-sm font-medium">Name</label>
            <Input readOnly={maskedCustomer} className="col-span-3" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} />
          </div>
          <div className="grid grid-cols-4 items-center gap-4">
            <label className="text-right text-sm font-medium">Expected Files</label>
            <Input type="number" className="col-span-3" value={formData.expected_weekly_files} onChange={e => setFormData({...formData, expected_weekly_files: Number(e.target.value)})} />
          </div>
          <div className="grid grid-cols-4 items-start gap-4">
            <label className="text-right text-sm font-medium mt-2">Patterns</label>
            <div className="col-span-3 space-y-1">
              <Input placeholder={maskedCustomer ? "Leave blank to keep current matching rules" : "Comma-separated matching patterns"} value={formData.filename_patterns} onChange={e => setFormData({...formData, filename_patterns: e.target.value})} />
              <p className="text-[10px] text-muted-foreground">
                {maskedCustomer ? "Customer identity and existing source rules are hidden and preserved. Enter patterns only to replace the matching rules." : "Comma-separated regex/strings to match filenames"}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-4 items-center gap-4">
            <label className="text-right text-sm font-medium">Active</label>
            <Switch checked={formData.active} onCheckedChange={c => setFormData({...formData, active: c})} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={handleSubmit} disabled={!formData.code || !formData.name}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PartsTab() {
  const [filterUncat, setFilterUncat] = useState(false);
  const [search, setSearch] = useState("");
  
  const { data: parts, isLoading } = useGetParts({ uncategorized: filterUncat || undefined });
  const updatePart = useUpdatePart();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const filteredParts = useMemo(() => {
    if (!parts) return [];
    if (!search) return parts;
    const q = search.toLowerCase();
    return parts.filter(p => p.part_no.toLowerCase().includes(q) || p.display_name?.toLowerCase().includes(q));
  }, [parts, search]);

  const handleUpdateCategory = (id: number, category: string) => {
    updatePart.mutate({ id, data: { category } }, {
      onSuccess: () => {
        toast({ title: "Part updated" });
        queryClient.invalidateQueries({ queryKey: getGetPartsQueryKey() });
      }
    });
  };

  const handleUpdateName = (id: number, display_name: string) => {
    updatePart.mutate({ id, data: { display_name } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetPartsQueryKey() });
      }
    });
  };

  return (
    <Card className="h-full flex flex-col shadow-xs">
      <CardHeader className="flex flex-col space-y-4 border-b">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Parts Master</CardTitle>
            <CardDescription>Manage product categories and friendly names</CardDescription>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Switch id="uncat" checked={filterUncat} onCheckedChange={setFilterUncat} />
            <label htmlFor="uncat">Uncategorized Only</label>
          </div>
        </div>
        <Input 
          placeholder="Search parts..." 
          value={search} 
          onChange={e => setSearch(e.target.value)} 
          className="max-w-md"
        />
      </CardHeader>
      <CardContent className="flex-1 p-0 overflow-auto">
        <Table>
          <TableHeader className="bg-muted/50 sticky top-0">
            <TableRow>
              <TableHead>Part No</TableHead>
              <TableHead>Friendly Name</TableHead>
              <TableHead>Category</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={3}><Skeleton className="h-8 w-full" /></TableCell></TableRow>
            ) : filteredParts.slice(0, 100).map((p) => (
              <TableRow key={p.id} className={p.category === 'Uncategorized' ? "bg-amber-50/50 dark:bg-amber-950/10" : ""}>
                <TableCell className="font-mono text-sm">
                  <div className="flex items-center gap-2">
                    {p.category === 'Uncategorized' && <AlertCircle className="h-4 w-4 text-amber-500" />}
                    {p.part_no}
                  </div>
                </TableCell>
                <TableCell>
                  <Input 
                    defaultValue={p.display_name || ""} 
                    onBlur={(e) => {
                      if (e.target.value !== (p.display_name || "")) {
                        handleUpdateName(p.id, e.target.value);
                      }
                    }}
                    className="h-8 text-sm"
                  />
                </TableCell>
                <TableCell>
                  <Select 
                    defaultValue={p.category} 
                    onValueChange={(v) => handleUpdateCategory(p.id, v)}
                  >
                    <SelectTrigger className="h-8 w-[160px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Uncategorized">Uncategorized</SelectItem>
                      <SelectItem value="SSD">SSD</SelectItem>
                      <SelectItem value="Monitor">Monitor</SelectItem>
                      <SelectItem value="Mobility">Mobility</SelectItem>
                    </SelectContent>
                  </Select>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {filteredParts.length > 100 && (
          <div className="p-4 text-center text-sm text-muted-foreground bg-muted/20 border-t">
            Showing first 100 of {filteredParts.length} parts. Use search to find specific items.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MappingsTab() {
  const { data: mappings, isLoading } = useGetColumnMappings();
  const deleteMapping = useDeleteColumnMapping();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleDelete = (id: number) => {
    if (confirm("Are you sure you want to delete this parser mapping?")) {
      deleteMapping.mutate({ id }, {
        onSuccess: () => {
          toast({ title: "Mapping deleted" });
          queryClient.invalidateQueries({ queryKey: getGetColumnMappingsQueryKey() });
        }
      });
    }
  };

  return (
    <Card className="h-full flex flex-col shadow-xs">
      <CardHeader className="border-b">
        <CardTitle>Column Mappings</CardTitle>
        <CardDescription>Saved parser rules for auto-detecting column layouts</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 p-0 overflow-auto">
        <Table>
          <TableHeader className="bg-muted/50 sticky top-0">
            <TableRow>
              <TableHead>Reseller</TableHead>
              <TableHead>Fingerprint</TableHead>
              <TableHead>Fields Mapped</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={4}><Skeleton className="h-8 w-full" /></TableCell></TableRow>
            ) : mappings?.length === 0 ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">No saved mappings found.</TableCell></TableRow>
            ) : mappings?.map((m) => {
              const mappedFields = Object.values(m.mapping as Record<string, string>).filter(v => v !== 'ignore');
              
              return (
                <TableRow key={m.id}>
                  <TableCell className="font-medium">{m.reseller_name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground truncate max-w-[200px]" title={m.fingerprint}>
                    {m.fingerprint}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1 flex-wrap">
                      {mappedFields.map((f, i) => (
                        <Badge key={i} variant="outline" className="text-[10px] bg-muted/50">{f}</Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" className="text-rose-600 hover:text-rose-700 hover:bg-rose-50" onClick={() => handleDelete(m.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
