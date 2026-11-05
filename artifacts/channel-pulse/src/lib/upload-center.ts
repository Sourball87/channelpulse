import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type CenterKind = "soh" | "claim" | "evidence" | "history" | "price" | "program" | "unknown";

export interface CenterUpload {
  id: string;
  kind: CenterKind;
  name: string;
  accountId: number | null;
  weekIso: string | null;
  sourceId: string | null;
  state: "preview" | "committed";
  createdAt: string;
  rowCount: number;
  summary: {
    skuCount: number; soh: number; unitsSold: number; serialCount: number;
    from: string; to: string; ddRangeCount: number; invoicedCount: number;
  };
  errors: string[];
  headers: string[];
  mapping: Record<string, string>;
  preview: Record<string, unknown>[];
}

export interface PriceRow {
  sku: string; description: string;
  rrpIncCents: number | null; ddCostExCents: number | null; t1BuyExCents: number | null;
  updatedAt: string;
}

export type ProgramRow = Record<string, unknown>;

export interface UploadCenterData { uploads: CenterUpload[]; prices: PriceRow[]; programRows: ProgramRow[] }

export const KIND_LABEL: Record<CenterKind, string> = {
  soh: "Customer SOH report",
  claim: "Customer serial / sales report",
  evidence: "DD serial report (Pronto)",
  history: "Historical approved claims",
  price: "Price list",
  program: "Scanback program table",
  unknown: "Unknown - choose type",
};
export const KIND_SHORT: Record<CenterKind, string> = {
  soh: "SOH", claim: "Serials", evidence: "DD serials", history: "History", price: "Prices", program: "Program", unknown: "Unknown",
};
export const CENTER_KINDS = Object.keys(KIND_LABEL) as CenterKind[];

export const UPLOAD_CENTER_KEY = ["/api/upload-center"] as const;

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && (body.error || body.message)) || `Request failed (${res.status})`);
  return body as T;
}

export function useUploadCenter() {
  return useQuery({
    queryKey: UPLOAD_CENTER_KEY,
    queryFn: () => req<UploadCenterData>("/api/upload-center"),
    refetchOnMount: "always",
  });
}

function useInvalidateAll() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries();
}

export function useCenterUpload() {
  const inv = useInvalidateAll();
  return useMutation({
    mutationFn: (v: { files: File[]; accountId?: number | null; weekIso?: string | null; kind?: CenterKind; aiAssist?: boolean }) => {
      const fd = new FormData();
      v.files.forEach((f) => fd.append("files", f));
      if (v.accountId != null) fd.append("accountId", String(v.accountId));
      if (v.weekIso) fd.append("weekIso", v.weekIso);
      if (v.kind) fd.append("kind", v.kind);
      fd.append("ai_assist", String(v.aiAssist !== false));
      return req<{ uploads: CenterUpload[]; errors: { name: string; error: string }[] }>("/api/upload-center/files", { method: "POST", body: fd });
    },
    onSettled: inv,
  });
}

export function usePatchCenterUpload() {
  const inv = useInvalidateAll();
  return useMutation({
    mutationFn: (v: { id: string; data: { kind?: CenterKind; accountId?: number | null; weekIso?: string | null; mapping?: Record<string, string> } }) =>
      req<CenterUpload>(`/api/upload-center/${encodeURIComponent(v.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v.data),
      }),
    onSettled: inv,
  });
}

export function useDeleteCenterUpload() {
  const inv = useInvalidateAll();
  return useMutation({
    mutationFn: (id: string) => req<unknown>(`/api/upload-center/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSettled: inv,
  });
}

export function useCommitCenterUpload() {
  const inv = useInvalidateAll();
  return useMutation({
    mutationFn: (id: string) => req<CenterUpload>(`/api/upload-center/${encodeURIComponent(id)}/commit`, { method: "POST" }),
    onSettled: inv,
  });
}

/* ---------- Week helpers (ISO week, week ending Sunday) ---------- */
const DAY = 86_400_000;

export function isoWeekOf(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y = t.getUTCFullYear();
  const wk = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / DAY + 1) / 7);
  return `${y}-W${String(wk).padStart(2, "0")}`;
}

/** Sunday that ends the last fully completed Mon-Sun week. */
export function lastCompletedSunday(now = new Date()): Date {
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dow = today.getUTCDay(); // 0 = Sunday
  const back = dow === 0 ? 7 : dow;
  return new Date(today.getTime() - back * DAY);
}

export function shiftSunday(d: Date, weeks: number): Date {
  return new Date(d.getTime() + weeks * 7 * DAY);
}

export function formatDay(d: Date): string {
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function shortDate(s: string | null | undefined): string {
  if (!s) return "-";
  const d = new Date(s.length <= 10 ? `${s}T00:00:00Z` : s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "2-digit", timeZone: "UTC" });
}

/* ---------- Program-table helpers ---------- */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
export function findHeading(row: ProgramRow, patterns: RegExp[]): string | undefined {
  return Object.keys(row).find((k) => patterns.some((p) => p.test(norm(k))));
}
export function rawCell(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}
