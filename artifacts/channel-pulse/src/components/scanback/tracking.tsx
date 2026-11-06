import type { ScanbackResult } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";

export type TrackingColor = "red" | "orange" | "amber" | "green" | "neutral";

/** Use backend-supplied colour; fall back for older drafts without it. */
export function trackingColorOf(r: ScanbackResult): TrackingColor {
  if (r.trackingColor) return r.trackingColor;
  const reason = r.reason.toLowerCase();
  if (r.status === "eligible") return "green";
  if (/also in earlier report|unmatched pronto credit/.test(reason)) return "amber";
  if (/already approved|already claimed|duplicate|already reported|reported sold|sold earlier/.test(reason)) return "red";
  if (/outside/.test(reason)) return "orange";
  return "neutral";
}

export const TRACKING_ROW: Record<TrackingColor, string> = {
  red: "bg-rose-50 border-l-4 border-l-rose-500",
  orange: "bg-orange-50 border-l-4 border-l-orange-400",
  amber: "bg-amber-50 border-l-4 border-l-amber-400",
  green: "bg-emerald-50/70 border-l-4 border-l-emerald-500",
  neutral: "border-l-4 border-l-transparent",
};

export const TRACKING_LABEL: Record<TrackingColor, string> = {
  red: "Already claimed / reported",
  orange: "Sell date outside dates (warning)",
  amber: "Review / earlier report",
  green: "Payable",
  neutral: "Unresolved / other",
};

const DOT: Record<TrackingColor, string> = {
  red: "bg-rose-500", orange: "bg-orange-400", amber: "bg-amber-400", green: "bg-emerald-500", neutral: "bg-slate-300",
};

export function TrackingTag({ color }: { color: TrackingColor }) {
  return (
    <span data-testid={`tracking-${color}`} className="inline-flex items-center gap-1 whitespace-nowrap text-[10px] font-medium uppercase tracking-wide text-slate-600">
      <span aria-hidden className={cn("h-2 w-2 rounded-full", DOT[color])} />{TRACKING_LABEL[color]}
    </span>
  );
}

export function TrackingLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b bg-slate-50/60 px-4 py-1.5 text-[11px] text-slate-600" data-testid="legend-tracking" role="note" aria-label="Row colour legend">
      <span className="font-semibold uppercase tracking-wider text-slate-500">Serial tracking</span>
      <span><TrackingTag color="red" /> <span className="text-slate-500">sold/claimed earlier (see reason for batch, promotion or report)</span></span>
      <span><TrackingTag color="orange" /></span>
      <span><TrackingTag color="amber" /> <span className="text-slate-500">same-customer repeat or unresolved Pronto credit</span></span>
      <span><TrackingTag color="green" /></span>
      <span><TrackingTag color="neutral" /> <span className="text-slate-500">review or other rejection</span></span>
    </div>
  );
}
