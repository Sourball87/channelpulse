import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { useGetAvailableWeeks } from "@workspace/api-client-react";
import {
  ArrowUp, ArrowDown, Minus, AlertTriangle, TrendingDown, TrendingUp, Zap,
  RefreshCw, ArrowRightLeft, Package, Users, ChevronRight, Info, Printer,
  Check, X, ExternalLink, Circle,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function apiFetch(path: string) {
  return fetch(`${BASE}${path}`).then(r => {
    if (!r.ok) throw new Error(`API error ${r.status}`);
    return r.json();
  });
}

function useInsightQuery<T>(key: string[], path: string, week: string, category: string) {
  const params = new URLSearchParams();
  if (week !== "latest") params.set("week_iso", week);
  if (category !== "All") params.set("category", category);
  const qs = params.toString();
  return useQuery<T>({
    queryKey: [...key, week, category],
    queryFn: () => apiFetch(`/api${path}${qs ? "?" + qs : ""}`),
    staleTime: 60_000,
  });
}

const CATEGORIES = ["All", "SSD", "Monitor", "Mobility", "HDD & Memory"];

// ── Colour helpers ────────────────────────────────────────────────────────────
function woiColor(woi: number | null) {
  if (woi === null) return "text-muted-foreground";
  if (woi <= 8) return "text-emerald-600 dark:text-emerald-400";
  if (woi <= 15) return "text-amber-500";
  return "text-red-500";
}
function woiBg(woi: number | null) {
  if (woi === null) return "bg-muted";
  if (woi <= 8) return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300";
  if (woi <= 15) return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
  return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
}
function healthColor(score: number) {
  if (score >= 75) return "text-emerald-600";
  if (score >= 50) return "text-amber-500";
  return "text-red-500";
}
function healthBorder(score: number) {
  if (score >= 75) return "border-emerald-400";
  if (score >= 50) return "border-amber-400";
  return "border-red-400";
}
function fmt(n: number | null | undefined, decimals = 0) {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-AU", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function fmtCurrency(n: number | null | undefined) {
  if (n === null || n === undefined || n === 0) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}
function ActionTag({ label }: { label: string }) {
  const colorMap: Record<string, string> = {
    "Sell-in opportunity": "bg-blue-100 text-blue-800",
    "Urgent replenish": "bg-red-100 text-red-800",
    "Run promo": "bg-orange-100 text-orange-800",
    "Rebalance": "bg-purple-100 text-purple-800",
    "Review pricing": "bg-yellow-100 text-yellow-800",
    "Transfer stock": "bg-indigo-100 text-indigo-800",
    "Range extension opportunity": "bg-teal-100 text-teal-800",
    "Slow ramp — consider sell-in push": "bg-orange-100 text-orange-800",
    "Confirm bulk deal to exclude from run-rate": "bg-gray-100 text-gray-800",
    "Investigate data with reseller": "bg-red-100 text-red-800",
  };
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded whitespace-nowrap ${colorMap[label] ?? "bg-muted text-muted-foreground"}`}>
      {label}
    </span>
  );
}
function Delta({ val, pct, invert, decimals }: { val: number | null; pct?: number | null; invert?: boolean; decimals?: number }) {
  if (val === null || val === undefined) return <span className="text-muted-foreground text-xs">—</span>;
  const positive = invert ? val < 0 : val > 0;
  const color = val === 0 ? "text-muted-foreground" : positive ? "text-emerald-600" : "text-red-500";
  const Icon = val === 0 ? Minus : val > 0 ? ArrowUp : ArrowDown;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs ${color}`}>
      <Icon className="h-3 w-3" />
      {pct != null ? `${Math.abs(pct).toFixed(1)}%` : decimals != null ? Math.abs(val).toFixed(decimals) : Math.abs(val).toLocaleString()}
    </span>
  );
}
function Sparkline({ data, field }: { data: { week_iso: string; soh?: number; st?: number }[]; field: "soh" | "st" }) {
  if (!data || data.length < 2) return null;
  const vals = data.map(d => d[field] ?? 0);
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const W = 64, H = 20;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * W},${H - ((v - min) / range) * H}`).join(" ");
  const last = vals[vals.length - 1], first = vals[0];
  const rising = last > first;
  return (
    <svg width={W} height={H} className="inline-block">
      <polyline points={pts} fill="none" stroke={rising ? "#10b981" : "#ef4444"} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

// ── Section shell ─────────────────────────────────────────────────────────────
function Section({ title, icon, children, count }: {
  title: string; icon: React.ReactNode; children: React.ReactNode; count?: number;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 pb-1 border-b">
        <span className="text-muted-foreground">{icon}</span>
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {count !== undefined && <Badge variant="secondary" className="text-xs">{count}</Badge>}
      </div>
      {children}
    </div>
  );
}

function InsufficientData({ weeks }: { weeks: number }) {
  return (
    <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
      Needs 2+ weeks of history to compute. {weeks} week{weeks !== 1 ? "s" : ""} of data available.
    </div>
  );
}

// ── Section 1: Health Scorecard ───────────────────────────────────────────────
function HealthSection({ week, category }: { week: string; category: string }) {
  const { data, isLoading } = useInsightQuery<any>(["insights-health"], "/insights/health", week, category);
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (!data) return null;
  if (data.insufficient_data && data.data_weeks_available < 2)
    return <InsufficientData weeks={data.data_weeks_available} />;

  const score = data.health_score ?? 0;
  const { kpis, sparklines = [], category_trends = [], coverage, score_breakdown } = data;

  return (
    <Section title="Channel Health Scorecard" icon={<Zap className="h-4 w-4" />}>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {/* Health Score */}
        <Card className={`border-2 ${healthBorder(score)}`}>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground mb-1">Health Score</div>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className={`text-3xl font-bold tabular-nums ${healthColor(score)} cursor-help`}>
                  {score}<span className="text-lg">/100</span>
                </div>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-xs">
                <p className="font-medium mb-1">Formula: {data.health_score_formula}</p>
                <div className="space-y-0.5">
                  <div>WOI fit: {score_breakdown?.woi_score?.toFixed(1)}/40</div>
                  <div>% green cells ({score_breakdown?.green_cell_pct?.toFixed(0)}%): {score_breakdown?.green_cell_score?.toFixed(1)}/30</div>
                  <div>ST momentum ({score_breakdown?.st_momentum_pct?.toFixed(1)}%): {score_breakdown?.momentum_score?.toFixed(1)}/20</div>
                  <div>Compliance ({coverage?.compliance_pct?.toFixed(0)}%): {score_breakdown?.compliance_score?.toFixed(1)}/10</div>
                </div>
              </TooltipContent>
            </Tooltip>
          </CardContent>
        </Card>

        {/* SOH */}
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground mb-1">Total SOH</div>
            <div className="text-xl font-bold tabular-nums">{fmt(kpis?.total_soh)}</div>
            <div className="flex items-center gap-2 mt-1">
              <Delta val={kpis?.total_soh_delta} />
              <Sparkline data={sparklines} field="soh" />
            </div>
          </CardContent>
        </Card>

        {/* ST */}
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground mb-1">Weekly Sell-Through</div>
            <div className="text-xl font-bold tabular-nums">{fmt(kpis?.total_st)}</div>
            <div className="flex items-center gap-2 mt-1">
              <Delta val={kpis?.total_st_delta} />
              <Sparkline data={sparklines} field="st" />
            </div>
          </CardContent>
        </Card>

        {/* WOI */}
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground mb-1">Blended WOI</div>
            <div className={`text-xl font-bold tabular-nums ${woiColor(kpis?.blended_woi)}`}>
              {kpis?.blended_woi != null ? fmt(kpis.blended_woi, 1) : "∞"}
            </div>
            <Delta val={kpis?.blended_woi_delta} decimals={1} invert />
          </CardContent>
        </Card>
      </div>

      {/* ST Trend by Category */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-1">
        {category_trends.map((ct: any) => (
          <div key={ct.category} className="rounded border px-3 py-2 flex items-center justify-between">
            <div>
              <div className="text-xs font-medium">{ct.category}</div>
              <div className={`text-xs mt-0.5 ${ct.momentum === "accelerating" ? "text-emerald-600" : ct.momentum === "declining" ? "text-red-500" : "text-muted-foreground"}`}>
                {ct.momentum} {ct.pct_change != null ? `(${ct.pct_change > 0 ? "+" : ""}${ct.pct_change.toFixed(0)}%)` : ""}
              </div>
            </div>
            {ct.momentum === "accelerating" ? <TrendingUp className="h-4 w-4 text-emerald-500" /> :
              ct.momentum === "declining" ? <TrendingDown className="h-4 w-4 text-red-500" /> :
                <Minus className="h-4 w-4 text-muted-foreground" />}
          </div>
        ))}
      </div>

      {/* Coverage row */}
      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground mt-1">
        <span>
          <span className="font-medium text-foreground">{coverage?.covered_skus}</span>/{coverage?.total_skus} SKUs with stock
          ({coverage?.coverage_pct?.toFixed(0)}% coverage)
        </span>
        <span>
          <span className="font-medium text-foreground">{coverage?.resellers_reported}</span>/{coverage?.resellers_expected} resellers reported
        </span>
      </div>
    </Section>
  );
}

// ── Section 2: Stock-Out Risk ─────────────────────────────────────────────────
function StockoutSection({ week, category }: { week: string; category: string }) {
  const { data, isLoading } = useInsightQuery<any>(["insights-stockout"], "/insights/stockout-risk", week, category);
  if (isLoading) return <Skeleton className="h-32 w-full" />;
  if (!data) return null;
  if (data.insufficient_data && data.data_weeks_available < 2)
    return (
      <Section title="Stock-Out Risk & Lost Sales" icon={<AlertTriangle className="h-4 w-4" />}>
        <InsufficientData weeks={data.data_weeks_available} />
      </Section>
    );

  const projTotal = data.projected_stockouts_total ?? 0;
  const activeTotal = data.active_stockouts_total ?? 0;
  const lost = data.lost_sales_headline ?? {};

  return (
    <Section
      title="Stock-Out Risk & Lost Sales"
      icon={<AlertTriangle className="h-4 w-4" />}
      count={projTotal + activeTotal}
    >
      {/* Lost sales headline */}
      {(lost.units > 0) && (
        <div className="rounded-md bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 px-3 py-2 text-sm">
          <span className="font-semibold text-red-700 dark:text-red-400">{fmt(lost.units)} units/week</span>
          {lost.value > 0 && <span className="text-red-600 dark:text-red-500"> (~{fmtCurrency(lost.value)})</span>}
          <span className="text-muted-foreground ml-1">estimated lost sales from active stockouts</span>
        </div>
      )}

      {/* Active stockouts */}
      {data.active_stockouts?.length > 0 && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">Active Stockouts ({activeTotal})</div>
          <div className="divide-y rounded-md border overflow-hidden">
            {data.active_stockouts.map((s: any) => (
              <div key={`${s.part_id}:${s.reseller_id}`} className="flex items-center gap-3 px-3 py-2 hover:bg-muted/40 text-sm">
                <div className="flex-1 min-w-0">
                  <span className="font-mono text-xs">{s.part_no}</span>
                  <span className="text-muted-foreground mx-1">@</span>
                  <span className="font-medium">{s.reseller_name}</span>
                  <span className="text-muted-foreground ml-2 text-xs">{fmt(s.trailing_avg_st, 1)} units/wk avg</span>
                  {s.confidence?.startsWith("low") && (
                    <Tooltip><TooltipTrigger><Info className="inline h-3 w-3 text-amber-400 ml-1" /></TooltipTrigger>
                      <TooltipContent>{s.confidence}</TooltipContent></Tooltip>
                  )}
                </div>
                <ActionTag label={s.action} />
                <a href={s.explorer_link} className="text-muted-foreground hover:text-foreground">
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Projected stockouts */}
      {data.projected_stockouts?.length > 0 && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">Projected Stock-Outs in &lt;{data.thresholds?.stockout_horizon_weeks} weeks ({projTotal})</div>
          <div className="divide-y rounded-md border overflow-hidden">
            {data.projected_stockouts.map((s: any) => (
              <div key={`${s.part_id}:${s.reseller_id}`} className="flex items-center gap-3 px-3 py-2 hover:bg-muted/40 text-sm">
                <div className="flex-1 min-w-0">
                  <span className="font-mono text-xs">{s.part_no}</span>
                  <span className="text-muted-foreground mx-1">@</span>
                  <span className="font-medium">{s.reseller_name}</span>
                  <span className="text-muted-foreground ml-2 text-xs">
                    {fmt(s.soh)} SOH · {s.weeks_to_zero?.toFixed(1)} wks to zero
                  </span>
                </div>
                <ActionTag label={s.action} />
                <a href={s.explorer_link} className="text-muted-foreground hover:text-foreground">
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            ))}
          </div>
        </div>
      )}

      {projTotal === 0 && activeTotal === 0 && (
        <div className="text-sm text-muted-foreground italic py-2">No stockout risks this week. ✓</div>
      )}
    </Section>
  );
}

// ── Section 3: Overstock & Ageing ─────────────────────────────────────────────
function OverstockSection({ week, category }: { week: string; category: string }) {
  const { data, isLoading } = useInsightQuery<any>(["insights-overstock"], "/insights/overstock", week, category);
  if (isLoading) return <Skeleton className="h-32 w-full" />;
  if (!data) return null;
  if (data.insufficient_data && data.data_weeks_available < 2)
    return (
      <Section title="Overstock & Ageing Risk" icon={<Package className="h-4 w-4" />}>
        <InsufficientData weeks={data.data_weeks_available} />
      </Section>
    );

  return (
    <Section
      title="Overstock & Ageing Risk"
      icon={<Package className="h-4 w-4" />}
      count={(data.overstocked_total ?? 0) + (data.dead_stock_total ?? 0)}
    >
      {data.dead_stock_value > 0 && (
        <div className="rounded-md bg-amber-50 dark:bg-amber-950/20 border border-amber-200 px-3 py-2 text-sm">
          <span className="font-semibold text-amber-700">{fmtCurrency(data.dead_stock_value)}</span>
          <span className="text-muted-foreground ml-1">dead stock (zero movement {data.thresholds?.dead_stock_weeks}+ weeks)</span>
        </div>
      )}

      {data.channel_overhang?.length > 0 && (
        <div className="rounded-md bg-red-50 dark:bg-red-950/20 border border-red-100 px-3 py-2 text-xs text-red-700">
          <span className="font-semibold">Channel overhang:</span>
          {data.channel_overhang.map((h: any) => (
            <span key={h.part_id} className="ml-2">
              {h.part_no} ({h.channel_woi?.toFixed(0)} WOI)
            </span>
          ))}
          <span className="ml-2 text-red-500">— pause sell-in</span>
        </div>
      )}

      {data.overstocked?.length > 0 && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">
            Overstocked Positions &gt;{data.thresholds?.woi_threshold} WOI ({data.overstocked_total})
          </div>
          <div className="divide-y rounded-md border overflow-hidden">
            {data.overstocked.map((s: any) => (
              <div key={`${s.part_id}:${s.reseller_id}`} className="flex items-center gap-3 px-3 py-2 hover:bg-muted/40 text-sm">
                <div className="flex-1 min-w-0">
                  <span className="font-mono text-xs">{s.part_no}</span>
                  <span className="text-muted-foreground mx-1">@</span>
                  <span className="font-medium">{s.reseller_name}</span>
                  <span className={`ml-2 text-xs font-medium ${woiColor(s.woi)}`}>{s.woi?.toFixed(1)} WOI</span>
                  <span className="text-muted-foreground ml-2 text-xs">{fmt(s.soh)} units {s.inv_value ? `· ${fmtCurrency(s.inv_value)}` : ""}</span>
                </div>
                <ActionTag label={s.action} />
                <a href={s.explorer_link} className="text-muted-foreground hover:text-foreground">
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            ))}
          </div>
        </div>
      )}

      {data.overstocked_total === 0 && data.dead_stock_total === 0 && (
        <div className="text-sm text-muted-foreground italic py-2">No overstock issues this week. ✓</div>
      )}
    </Section>
  );
}

// ── Section 4: Rebalancing ────────────────────────────────────────────────────
function RebalancingSection({ week, category }: { week: string; category: string }) {
  const { data, isLoading } = useInsightQuery<any>(["insights-rebalancing"], "/insights/rebalancing", week, category);
  if (isLoading) return <Skeleton className="h-32 w-full" />;
  if (!data) return null;
  if (data.insufficient_data)
    return (
      <Section title="Rebalancing Opportunities" icon={<ArrowRightLeft className="h-4 w-4" />}>
        <InsufficientData weeks={data.data_weeks_available} />
      </Section>
    );

  const ops = data.opportunities ?? [];

  return (
    <Section
      title="Rebalancing Opportunities"
      icon={<ArrowRightLeft className="h-4 w-4" />}
      count={data.opportunities_total}
    >
      {ops.length === 0 ? (
        <div className="text-sm text-muted-foreground italic py-2">No rebalancing opportunities identified. ✓</div>
      ) : (
        <div className="divide-y rounded-md border overflow-hidden">
          {ops.map((op: any, i: number) => (
            <div key={i} className="px-3 py-2.5 hover:bg-muted/40">
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-sm flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-xs font-medium">{op.part_no}</span>
                    <span className="text-xs text-muted-foreground">{op.display_name}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1 text-xs flex-wrap">
                    {/* Donor */}
                    <span className="inline-flex items-center gap-1 rounded bg-red-50 dark:bg-red-950/30 border border-red-200 px-2 py-0.5">
                      <span className="font-medium text-red-700">{op.starved_reseller_name}</span>
                      <span className="text-muted-foreground">{op.starved_soh === 0 ? "STOCKED OUT" : `${op.starved_woi?.toFixed(1)} WOI`}</span>
                    </span>
                    <ArrowRightLeft className="h-3 w-3 text-muted-foreground" />
                    {/* Source */}
                    <span className="inline-flex items-center gap-1 rounded bg-amber-50 dark:bg-amber-950/30 border border-amber-200 px-2 py-0.5">
                      <span className="font-medium text-amber-700">{op.donor_reseller_name}</span>
                      <span className="text-muted-foreground">{op.donor_woi?.toFixed(1)} WOI · {fmt(op.donor_soh)} units</span>
                    </span>
                    <span className="text-muted-foreground">→ transfer</span>
                    <span className="font-semibold text-foreground">{fmt(op.suggested_transfer_qty)} units</span>
                    {op.transfer_value && <span className="text-muted-foreground">({fmtCurrency(op.transfer_value)})</span>}
                  </div>
                </div>
                <a href={op.explorer_link} className="text-muted-foreground hover:text-foreground mt-1">
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
      {data.opportunities_total > 7 && (
        <div className="text-xs text-muted-foreground text-right">
          Showing 7 of {data.opportunities_total} opportunities
        </div>
      )}
    </Section>
  );
}

// ── Section 5: Whitespace ─────────────────────────────────────────────────────
function WhitespaceSection({ week, category }: { week: string; category: string }) {
  const { data, isLoading } = useInsightQuery<any>(["insights-whitespace"], "/insights/whitespace", week, category);
  if (isLoading) return <Skeleton className="h-32 w-full" />;
  if (!data) return null;
  if (data.insufficient_data)
    return (
      <Section title="Range & Whitespace" icon={<TrendingUp className="h-4 w-4" />}>
        <InsufficientData weeks={data.data_weeks_available} />
      </Section>
    );

  const gaps = data.range_gaps ?? [];
  const breadths = data.breadth_scores ?? [];
  const newLines = data.new_line_adoption ?? [];

  return (
    <Section title="Range & Whitespace" icon={<TrendingUp className="h-4 w-4" />} count={data.range_gaps_total}>
      {/* Range gaps */}
      {gaps.length > 0 && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">Top-Quartile SKUs Not Ranged ({data.range_gaps_total})</div>
          <div className="divide-y rounded-md border overflow-hidden">
            {gaps.map((g: any, i: number) => (
              <div key={i} className="flex items-center gap-3 px-3 py-2 hover:bg-muted/40 text-sm">
                <div className="flex-1 min-w-0">
                  <span className="font-mono text-xs">{g.part_no}</span>
                  <span className="text-muted-foreground mx-1">not at</span>
                  <span className="font-medium">{g.reseller_name}</span>
                  <span className="text-muted-foreground ml-2 text-xs">
                    {fmt(g.channel_total_st)} units/wk channel · est. +{fmt(g.est_opportunity_units_per_week)}/wk
                  </span>
                </div>
                <ActionTag label={g.action} />
                <a href={g.explorer_link} className="text-muted-foreground hover:text-foreground">
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Breadth scores */}
      <div>
        <div className="text-xs font-medium text-muted-foreground mb-1">Range Breadth by Reseller</div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5">
          {breadths.map((b: any) => (
            <div key={b.reseller_id} className="flex items-center justify-between rounded border px-2 py-1.5 text-xs">
              <span className="font-medium truncate">{b.reseller_name}</span>
              <span className={`ml-2 font-mono ${b.breadth_pct > 70 ? "text-emerald-600" : b.breadth_pct > 40 ? "text-amber-500" : "text-red-500"}`}>
                {b.breadth_pct.toFixed(0)}%
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* New line adoption */}
      {newLines.length > 0 && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">New Line Adoption</div>
          <div className="divide-y rounded-md border overflow-hidden">
            {newLines.map((nl: any) => (
              <div key={nl.part_id} className="flex items-center gap-3 px-3 py-2 hover:bg-muted/40 text-sm">
                <div className="flex-1 min-w-0">
                  <span className="font-mono text-xs">{nl.part_no}</span>
                  <span className="text-muted-foreground ml-2 text-xs">
                    first seen {nl.first_week} · {nl.resellers_ranged}/{nl.total_resellers} resellers
                  </span>
                  {nl.slow_ramp && <Badge variant="outline" className="ml-2 text-[10px] text-amber-600 border-amber-300">Slow ramp</Badge>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}

// ── Section 6: Reseller Performance ──────────────────────────────────────────
function ResellerPerfSection({ week, category, onAnnotate }: {
  week: string; category: string;
  onAnnotate: (type: string, resellerId?: number, partId?: number, note?: string) => void;
}) {
  const { data, isLoading } = useInsightQuery<any>(["insights-reseller-perf"], "/insights/reseller-performance", week, category);
  if (isLoading) return <Skeleton className="h-32 w-full" />;
  if (!data) return null;
  if (data.insufficient_data && data.data_weeks_available < 2)
    return (
      <Section title="Reseller Performance" icon={<Users className="h-4 w-4" />}>
        <InsufficientData weeks={data.data_weeks_available} />
      </Section>
    );

  const leaders = data.leaderboard ?? [];
  const conc = data.concentration ?? {};
  const anomalies = data.anomalies ?? [];

  return (
    <Section title="Reseller Performance & Concentration" icon={<Users className="h-4 w-4" />}>
      {/* Leaderboard */}
      <div className="rounded-md border overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-muted/50 border-b text-left">
              <th className="px-3 py-2 font-medium">Reseller</th>
              <th className="px-3 py-2 font-medium text-right">ST</th>
              <th className="px-3 py-2 font-medium text-right">Share</th>
              <th className="px-3 py-2 font-medium text-right">WoW</th>
              <th className="px-3 py-2 font-medium text-right">WOI</th>
              <th className="px-3 py-2 font-medium text-right">Range</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {leaders.map((r: any, i: number) => (
              <tr key={r.reseller_id} className="hover:bg-muted/30">
                <td className="px-3 py-2">
                  <span className="text-muted-foreground mr-1">{i + 1}.</span>
                  <span className="font-medium">{r.reseller_name}</span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(r.total_st)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.st_share_pct?.toFixed(1)}%</td>
                <td className="px-3 py-2 text-right">
                  <Delta val={r.st_share_delta} pct={r.st_share_delta} />
                </td>
                <td className={`px-3 py-2 text-right font-medium ${woiColor(r.avg_woi)}`}>
                  {r.avg_woi != null ? r.avg_woi.toFixed(1) : "∞"}
                </td>
                <td className="px-3 py-2 text-right">{r.breadth_pct?.toFixed(0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Concentration */}
      {(conc.top1_share_pct > 40 || conc.top3_share_pct > 75) && (
        <div className="rounded-md bg-amber-50 dark:bg-amber-950/20 border border-amber-200 px-3 py-2 text-xs">
          <span className="font-semibold text-amber-700">Concentration: </span>
          <span className="text-amber-700">{conc.top1_reseller} holds {conc.top1_share_pct?.toFixed(0)}% of ST; top 3 = {conc.top3_share_pct?.toFixed(0)}%</span>
          {conc.concentration_risks?.length > 0 && (
            <div className="mt-1 text-amber-600">
              SKU concentration risk: {conc.concentration_risks.slice(0, 3).map((r: any) =>
                `${r.part_no} (${r.share_pct?.toFixed(0)}% from ${r.reseller_name})`
              ).join(", ")}
            </div>
          )}
        </div>
      )}

      {/* Anomalies */}
      {anomalies.filter((a: any) => !a.dismissed).length > 0 && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">Anomalies</div>
          <div className="divide-y rounded-md border overflow-hidden">
            {anomalies.filter((a: any) => !a.dismissed).slice(0, 5).map((a: any, i: number) => (
              <div key={i} className="flex items-center gap-3 px-3 py-2 hover:bg-muted/40 text-sm">
                <div className="flex-1 min-w-0 text-xs">
                  <span className="font-medium">{a.part_no}</span>
                  <span className="text-muted-foreground mx-1">@</span>
                  <span>{a.reseller_name}</span>
                  <span className="text-muted-foreground ml-2">{a.note}</span>
                </div>
                <ActionTag label={a.action} />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-xs text-muted-foreground"
                  onClick={() => onAnnotate("bulk_deal", a.reseller_id, a.part_id, "Confirmed bulk deal")}
                >
                  <Check className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}

// ── Weekly Summary Export ─────────────────────────────────────────────────────
function SummaryExport({ week, category, health, stockout, overstock, rebalancing, resellerPerf }: any) {
  const handleExport = () => {
    const w = window.open("", "_blank");
    if (!w) return;
    const html = `<!DOCTYPE html>
<html>
<head>
<title>ChannelPulse Weekly Summary — ${week}</title>
<style>
  body { font-family: system-ui, sans-serif; font-size: 12px; color: #111; max-width: 800px; margin: 40px auto; padding: 0 24px; }
  h1 { font-size: 18px; border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 16px; }
  h2 { font-size: 13px; margin-top: 20px; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; color: #555; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
  th { background: #f4f4f4; font-weight: 600; text-align: left; }
  td, th { padding: 5px 8px; border: 1px solid #e0e0e0; }
  .score { font-size: 36px; font-weight: 700; }
  .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
  .kpi { border: 1px solid #e0e0e0; border-radius: 4px; padding: 8px; }
  .kpi-label { font-size: 10px; color: #888; margin-bottom: 2px; }
  .kpi-val { font-size: 18px; font-weight: 700; }
  @media print { @page { margin: 15mm; } }
</style>
</head>
<body>
<h1>ChannelPulse — Weekly Channel Summary</h1>
<div style="color:#888;margin-bottom:16px">Week: ${health?.week_iso ?? week} ${category !== "All" ? `| Category: ${category}` : ""} | Generated: ${new Date().toLocaleDateString("en-AU")}</div>

<h2>Channel Health</h2>
<div class="kpi-grid">
  <div class="kpi"><div class="kpi-label">Health Score</div><div class="kpi-val" style="color:${(health?.health_score ?? 0) >= 75 ? "#16a34a" : (health?.health_score ?? 0) >= 50 ? "#d97706" : "#dc2626"}">${health?.health_score ?? "—"}/100</div></div>
  <div class="kpi"><div class="kpi-label">Total SOH</div><div class="kpi-val">${(health?.kpis?.total_soh ?? 0).toLocaleString()}</div></div>
  <div class="kpi"><div class="kpi-label">Weekly ST</div><div class="kpi-val">${(health?.kpis?.total_st ?? 0).toLocaleString()}</div></div>
  <div class="kpi"><div class="kpi-label">Blended WOI</div><div class="kpi-val">${health?.kpis?.blended_woi?.toFixed(1) ?? "—"}</div></div>
</div>
<p style="font-size:11px;color:#555">Coverage: ${health?.coverage?.covered_skus}/${health?.coverage?.total_skus} SKUs · ${health?.coverage?.resellers_reported}/${health?.coverage?.resellers_expected} resellers reported</p>

<h2>Top 5 Risks</h2>
<table>
<tr><th>Type</th><th>SKU</th><th>Reseller</th><th>Details</th></tr>
${(stockout?.active_stockouts?.slice(0, 3) ?? []).map((s: any) => `<tr><td>Active Stockout</td><td>${s.part_no}</td><td>${s.reseller_name}</td><td>~${s.trailing_avg_st?.toFixed(0)} units/wk lost</td></tr>`).join("")}
${(overstock?.overstocked?.slice(0, 2) ?? []).map((s: any) => `<tr><td>Overstocked</td><td>${s.part_no}</td><td>${s.reseller_name}</td><td>${s.woi?.toFixed(1)} WOI · ${s.soh} units</td></tr>`).join("")}
</table>

<h2>Top 5 Opportunities</h2>
<table>
<tr><th>Type</th><th>SKU</th><th>Details</th><th>Action</th></tr>
${(rebalancing?.opportunities?.slice(0, 5) ?? []).map((op: any) => `<tr><td>Rebalance</td><td>${op.part_no}</td><td>${op.starved_reseller_name} (${op.starved_woi?.toFixed(1) ?? "OOS"} WOI) ← ${op.donor_reseller_name} (${op.donor_woi?.toFixed(1)} WOI)</td><td>Transfer ${op.suggested_transfer_qty} units</td></tr>`).join("")}
</table>

<h2>Reseller Sell-Through Leaderboard</h2>
<table>
<tr><th>#</th><th>Reseller</th><th>ST Units</th><th>Share</th><th>WOI</th><th>Range %</th></tr>
${(resellerPerf?.leaderboard ?? []).map((r: any, i: number) => `<tr><td>${i + 1}</td><td>${r.reseller_name}</td><td>${(r.total_st ?? 0).toLocaleString()}</td><td>${r.st_share_pct?.toFixed(1)}%</td><td>${r.avg_woi?.toFixed(1) ?? "—"}</td><td>${r.breadth_pct?.toFixed(0)}%</td></tr>`).join("")}
</table>

<div style="margin-top:32px;font-size:10px;color:#aaa;border-top:1px solid #eee;padding-top:8px">
  Generated by ChannelPulse · ${new Date().toLocaleString("en-AU")}
</div>
</body>
</html>`;
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 500);
  };

  return (
    <Button variant="outline" size="sm" onClick={handleExport} className="gap-2">
      <Printer className="h-3.5 w-3.5" />
      Generate Weekly Summary
    </Button>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function Insights() {
  const [week, setWeek] = useState("latest");
  const [category, setCategory] = useState("All");
  const queryClient = useQueryClient();

  const { data: weeks } = useGetAvailableWeeks();
  const queryWeek = week === "latest" ? (weeks?.[0]?.week_iso ?? "latest") : week;

  const { data: health } = useInsightQuery<any>(["insights-health"], "/insights/health", queryWeek, category);
  const { data: stockout } = useInsightQuery<any>(["insights-stockout"], "/insights/stockout-risk", queryWeek, category);
  const { data: overstock } = useInsightQuery<any>(["insights-overstock"], "/insights/overstock", queryWeek, category);
  const { data: rebalancing } = useInsightQuery<any>(["insights-rebalancing"], "/insights/rebalancing", queryWeek, category);
  const { data: resellerPerf } = useInsightQuery<any>(["insights-reseller-perf"], "/insights/reseller-performance", queryWeek, category);

  // Annotations
  const annotateMutation = useMutation({
    mutationFn: (body: { annotation_type: string; reseller_id?: number; part_id?: number; week_iso?: string; note: string }) =>
      fetch(`${BASE}/api/insights/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, week_iso: queryWeek }),
      }).then(r => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["insights-reseller-perf"] }),
  });

  // Health sentence
  const score = health?.health_score ?? null;
  const woi = health?.kpis?.blended_woi;
  const st = health?.kpis?.total_st;
  const stockoutCount = (stockout?.active_stockouts_total ?? 0) + (stockout?.projected_stockouts_total ?? 0);
  const healthSentence = score != null
    ? `Channel health score ${score}/100 — blended WOI ${woi?.toFixed(1) ?? "n/a"}, ${(st ?? 0).toLocaleString()} units sold this week` +
    (stockoutCount > 0 ? `, ${stockoutCount} stockout risk${stockoutCount !== 1 ? "s" : ""} flagged` : "") +
    (rebalancing?.opportunities_total > 0 ? `, ${rebalancing.opportunities_total} rebalancing ${rebalancing.opportunities_total === 1 ? "opportunity" : "opportunities"}` : ".")
    : "Computing channel insights…";

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b bg-background/95 backdrop-blur shrink-0">
        <div>
          <h1 className="text-lg font-semibold">Insights</h1>
          <p className="text-xs text-muted-foreground">{healthSentence}</p>
        </div>
        <div className="flex items-center gap-2">
          <SummaryExport week={queryWeek} category={category} health={health} stockout={stockout} overstock={overstock} rebalancing={rebalancing} resellerPerf={resellerPerf} />
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={week} onValueChange={setWeek}>
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue placeholder="Latest Week" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="latest">Latest Week</SelectItem>
              {(weeks ?? []).map((w: any) => (
                <SelectItem key={w.week_iso} value={w.week_iso}>{w.week_iso}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-8">
        <HealthSection week={queryWeek} category={category} />
        <StockoutSection week={queryWeek} category={category} />
        <OverstockSection week={queryWeek} category={category} />
        <RebalancingSection week={queryWeek} category={category} />
        <WhitespaceSection week={queryWeek} category={category} />
        <ResellerPerfSection
          week={queryWeek}
          category={category}
          onAnnotate={(type, resellerId, partId, note) =>
            annotateMutation.mutate({ annotation_type: type, reseller_id: resellerId, part_id: partId, note: note ?? "" })
          }
        />
        <div className="h-8" />
      </div>
    </div>
  );
}
