import { useQueryClient } from "@tanstack/react-query";
import {
  getGetScanbackWorkspaceQueryKey,
  useGetScanbackWorkspace,
  type ScanbackResultStatus,
} from "@workspace/api-client-react";
import { cn } from "@/lib/utils";

export function formatCents(c: number | null | undefined): string {
  if (c == null) return "Missing";
  const neg = c < 0;
  const abs = Math.abs(c);
  const dollars = Math.floor(abs / 100).toLocaleString("en-AU");
  const cents = String(abs % 100).padStart(2, "0");
  return `${neg ? "-" : ""}$${dollars}.${cents}`;
}

/** Parse a dollars string into integer cents without float arithmetic. Returns null when blank, NaN when invalid. */
export function parseCents(raw: string): number | null {
  const s = raw.trim().replace(/[$,]/g, "");
  if (!s) return null;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return Number.NaN;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

export function centsToInput(c: number | null | undefined): string {
  if (c == null) return "";
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    const d = (e as Error & { data?: unknown }).data as { error?: string; message?: string } | null | undefined;
    return (d && typeof d === "object" && (d.error || d.message)) || e.message;
  }
  return "Unexpected error";
}

export function formatDate(s: string | null | undefined): string {
  if (!s) return "-";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });
}

export function formatDateTime(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString("en-AU", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function useScanbackWorkspace() {
  return useGetScanbackWorkspace({
    query: { queryKey: getGetScanbackWorkspaceQueryKey(), refetchInterval: 30000, refetchOnWindowFocus: true },
  });
}

export function useRefreshWorkspace() {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: getGetScanbackWorkspaceQueryKey() }),
    qc.invalidateQueries({ queryKey: ["/api/upload-center"] }),
  ]);
}

const STATUS_STYLE: Record<ScanbackResultStatus, string> = {
  eligible: "bg-emerald-50 text-emerald-800 ring-emerald-600/25",
  review: "bg-amber-50 text-amber-800 ring-amber-600/30",
  rejected: "bg-rose-50 text-rose-800 ring-rose-600/25",
};
const STATUS_LABEL: Record<ScanbackResultStatus, string> = {
  eligible: "Eligible",
  review: "Needs review",
  rejected: "Rejected",
};

export function StatusPill({ status }: { status: ScanbackResultStatus }) {
  return (
    <span
      data-testid={`status-${status}`}
      className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset whitespace-nowrap", STATUS_STYLE[status])}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export function SectionEmpty({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50/60 px-6 py-10 text-center">
      <p className="text-sm font-semibold text-slate-700">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
