import { useState } from "react";
import { useSaveScanbackProgram, type Part, type Reseller, type ScanbackProgram } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Archive, ArchiveRestore, Pencil, Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ProgramEditor } from "./program-editor";
import { SectionEmpty, errorMessage, formatCents, formatDate, useRefreshWorkspace } from "./shared";

export function ProgramsPanel({ programs, resellers, parts }: { programs: ScanbackProgram[]; resellers: Reseller[]; parts: Part[] }) {
  const [editing, setEditing] = useState<ScanbackProgram | null>(null);
  const [open, setOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const save = useSaveScanbackProgram();
  const refresh = useRefreshWorkspace();
  const { toast } = useToast();
  const partById = new Map(parts.map((p) => [p.id, p]));
  const resById = new Map(resellers.map((r) => [r.id, r]));
  const visible = programs.filter((p) => showArchived || !p.archived);

  const toggleArchive = (p: ScanbackProgram) => {
    const { createdAt: _c, ...rest } = p;
    void _c;
    save.mutate(
      { data: { ...rest, archived: !p.archived } },
      {
        onSuccess: () => { toast({ title: p.archived ? "Promotion restored" : "Promotion archived" }); refresh(); },
        onError: (e) => toast({ title: "Could not update promotion", description: errorMessage(e), variant: "destructive" }),
      },
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600 max-w-2xl">
          Promotions define who can claim, which SKUs qualify and the GTM Buy Ex deducted from the reseller's invoiced price.
          Used promotions can be archived, never deleted.
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" data-testid="button-toggle-archived" onClick={() => setShowArchived((s) => !s)}>
            {showArchived ? "Hide archived" : "Show archived"}
          </Button>
          <Button size="sm" data-testid="button-new-program" onClick={() => { setEditing(null); setOpen(true); }}>
            <Plus className="mr-1 h-4 w-4" /> New promotion
          </Button>
        </div>
      </div>

      {visible.length === 0 ? (
        <SectionEmpty title="No promotions yet" body="Create a promotion with eligible customers, SKUs and GTM Buy Ex before verifying claims." />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {visible.map((p) => (
            <article key={p.id} data-testid={`card-program-${p.id}`} className={`rounded-lg border bg-background p-4 ${p.archived ? "opacity-60" : ""}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold text-slate-800">{p.name}</h3>
                  <p className="font-mono text-xs text-slate-500">{formatDate(p.start)} to {formatDate(p.end)} &middot; v{p.version}</p>
                </div>
                <div className="flex items-center gap-1">
                  {p.archived && <Badge variant="secondary">Archived</Badge>}
                  <Button variant="ghost" size="icon" aria-label="Edit" data-testid={`button-edit-program-${p.id}`} onClick={() => { setEditing(p); setOpen(true); }}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label={p.archived ? "Restore" : "Archive"} disabled={save.isPending} data-testid={`button-archive-program-${p.id}`} onClick={() => toggleArchive(p)}>
                    {p.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
              {p.notes && <p className="mt-2 text-sm text-slate-600">{p.notes}</p>}
              <div className="mt-3 flex flex-wrap gap-1">
                {p.customerIds.map((id) => (
                  <span key={id} className="rounded bg-cyan-50 px-1.5 py-0.5 font-mono text-[11px] text-cyan-800">{resById.get(id)?.code ?? `#${id}`}</span>
                ))}
              </div>
              <table className="mt-3 w-full text-sm">
                <thead><tr className="text-left text-xs text-slate-500"><th className="font-medium">SKU</th><th className="text-right font-medium">GTM Buy Ex</th><th className="text-right font-medium">Caps</th></tr></thead>
                <tbody>
                  {p.lines.map((l) => (
                    <tr key={l.sku ?? l.partId} className="border-t border-slate-100">
                      <td className="py-1 font-mono text-xs">{l.sku ?? partById.get(l.partId ?? -1)?.part_no ?? `#${l.partId}`}</td>
                      <td className="py-1 text-right tabular-nums">{formatCents(l.gtmBuyCents)}</td>
                      <td className="py-1 text-right text-xs text-slate-500">
                        {l.caps.filter((c) => c.quantity != null).length === 0
                          ? "Unlimited"
                          : l.caps.filter((c) => c.quantity != null).map((c) => `${resById.get(c.resellerId)?.code ?? c.resellerId}: ${c.quantity}`).join(", ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </article>
          ))}
        </div>
      )}

      <ProgramEditor open={open} onOpenChange={setOpen} program={editing} resellers={resellers} parts={parts} />
    </div>
  );
}
