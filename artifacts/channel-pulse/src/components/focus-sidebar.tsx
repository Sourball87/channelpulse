import { customerLabel } from "@/lib/customer-display";
import { useMemo, useState } from "react";
import { useFilters } from "@/context/filter-context";
import {
  useGetParts,
  useGetResellers,
  useGetDashboardWeeklySales,
  getGetDashboardWeeklySalesQueryKey,
} from "@workspace/api-client-react";
import { X } from "lucide-react";
import { trackEvent } from "@/lib/analytics";

type DimKey = "code" | "sku";

interface Option {
  key: string;
  label: string;
  selected: boolean;
  onPick: () => void;
}

const ACCOUNT_DIMS: { key: DimKey; label: string }[] = [
  { key: "code", label: "Account Code" },
];
const STOCK_DIMS: { key: DimKey; label: string }[] = [
  { key: "sku", label: "Stock Code" },
];

const dimBtn =
  "w-full h-9 rounded-[2px] border border-[#cfd2d6] bg-[#ececec] text-[13px] text-[#333] hover:bg-[#e0e0e0] aria-expanded:bg-[#d6dde2] aria-expanded:border-[#5bc6e0]";

export function FocusSidebar() {
  const { partIds, resellerIds, setFilters, clearFilters, isFiltered, apiParams, insightWeek } = useFilters();
  const { data: parts } = useGetParts();
  const { data: resellers } = useGetResellers();
  const [open, setOpen] = useState(true);
  const [dim, setDim] = useState<DimKey | null>(null);
  const [q, setQ] = useState("");

  const heatParams = { week_iso: insightWeek, reseller_ids: apiParams.reseller_ids };
  const scoped = resellerIds.length > 0;
  const heat = useGetDashboardWeeklySales(heatParams, {
    query: { enabled: scoped, queryKey: getGetDashboardWeeklySalesQueryKey(heatParams) },
  });

  const allParts = useMemo(() => parts ?? [], [parts]);
  const selectedParts = useMemo(() => allParts.filter((p) => partIds.includes(p.id)), [allParts, partIds]);

  const scopedPartIds = useMemo(() => {
    if (!scoped || !heat.isSuccess || !heat.data) return null;
    return new Set(
      heat.data.cells.map((c) => c.part_id),
    );
  }, [scoped, heat.isSuccess, heat.data, resellerIds]);

  const stockStatus: "loading" | "error" | "ok" =
    scoped && heat.isLoading ? "loading" : scoped && heat.isError ? "error" : "ok";

  const options: Option[] = useMemo(() => {
    if (!dim) return [];
    const s = q.trim().toLowerCase();
    if (dim === "code") {
      return (resellers ?? [])
        .filter((r) => !s || customerLabel(r.code).toLowerCase().includes(s))
        .map((r) => ({
          key: String(r.id),
          label: customerLabel(r.code),
          selected: resellerIds.includes(r.id),
          onPick: () => setFilters({ resellerIds: [r.id] }),
        }));
    }
    return allParts
      .filter((p) => {
        // Keep selected stock codes available so they can still be cleared.
        if (partIds.includes(p.id)) return true;
        if (scopedPartIds && !scopedPartIds.has(p.id)) return false;
        return true;
      })
      .filter(
        (p) =>
          !s || p.part_no.toLowerCase().includes(s),
      )
      .map((p) => ({
        key: String(p.id),
        label: p.part_no,
        selected: partIds.includes(p.id),
        onPick: () => setFilters({ partIds: [p.id] }),
      }));
  }, [dim, q, resellers, allParts, resellerIds, partIds, scopedPartIds, setFilters]);

  const chips: { key: string; label: string; remove: () => void }[] = [];
  for (const id of resellerIds) {
    const r = resellers?.find((x) => x.id === id);
    chips.push({
      key: `r${id}`,
      label: `Account: ${customerLabel(r?.code ?? id)}`,
      remove: () => setFilters({ resellerIds: resellerIds.filter((x) => x !== id) }),
    });
  }
  for (const p of selectedParts) {
    chips.push({
      key: `p${p.id}`,
      label: `SKU: ${p.part_no}`,
      remove: () => setFilters({ partIds: partIds.filter((x) => x !== p.id) }),
    });
  }

  const reset = () => {
    setDim(null);
    setQ("");
    clearFilters();
  };

  const renderDim = (d: { key: DimKey; label: string }) => {
    const expanded = dim === d.key;
    const stockDim = d.key === "sku";
    return (
      <div key={d.key}>
        <button
          type="button"
          aria-expanded={expanded}
          data-testid={`button-dim-${d.key}`}
          className={dimBtn}
          onClick={() => {
            if (!expanded) trackEvent("focus_dimension_opened", { dimension: d.key });
            setDim(expanded ? null : d.key);
            setQ("");
          }}
        >
          {d.label}
        </button>
        {expanded && (
          <div className="mt-1 mb-1 rounded-[2px] border border-[#cfd2d6] bg-[#f6f6f6] text-[#333]">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${d.label}`}
              aria-label={`Search ${d.label}`}
              data-testid={`input-search-${d.key}`}
              className="w-full border-b border-[#cfd2d6] bg-white px-2 py-1.5 text-xs outline-none"
            />
            <div className="max-h-56 overflow-y-auto">
              <button
                type="button"
                className="w-full px-2 py-1.5 text-left text-xs text-[#0a8fb0] hover:bg-[#e8e8e8]"
                onClick={() =>
                  setFilters(
                    d.key === "code" ? { resellerIds: [] } : { partIds: [] },
                  )
                }
              >
                All (clear)
              </button>
              {stockDim && stockStatus === "loading" && (
                <p className="px-2 py-1.5 text-xs text-[#666]">Loading stock for selected accounts...</p>
              )}
              {stockDim && stockStatus === "error" && (
                <p className="px-2 py-1.5 text-xs text-[#c0300a]">
                  Could not scope stock to accounts; showing all.
                </p>
              )}
              {options.length === 0 && stockStatus !== "loading" && (
                <p className="px-2 py-1.5 text-xs text-[#666]">No matching values</p>
              )}
               {(!stockDim || stockStatus !== "loading") && options.map((o) => (
                <button
                  key={o.key}
                  type="button"
                  aria-pressed={o.selected}
                  onClick={o.onPick}
                  className={`flex w-full flex-col px-2 py-1.5 text-left text-xs hover:bg-[#e8e8e8] ${
                    o.selected ? "bg-[#d3eef6] font-semibold" : ""
                  }`}
                >
                  <span className="truncate">{o.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="px-3 pb-4 space-y-3" data-testid="panel-focus-sidebar">
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          aria-pressed={open}
          aria-label={open ? "Focus, collapse account and stock controls" : "Focus, expand account and stock controls"}
          data-testid="button-focus"
          onClick={() => {
            trackEvent("focus_toggled", { expanded: !open });
            setOpen(!open);
          }}
          className={`h-9 rounded-[2px] text-[13px] text-white ${open ? "bg-[#37b6d6]" : "bg-[#8fd3e6]"}`}
        >
          Focus
        </button>
        <button
          type="button"
          data-testid="button-reset"
          onClick={reset}
          disabled={!isFiltered}
          className="h-9 rounded-[2px] bg-[#ee3a0f] text-[13px] text-white disabled:opacity-60"
        >
          Reset
        </button>
      </div>
      <div className="rounded-[2px] bg-[#4ec3e0] px-2 py-2 text-center text-[13px] font-medium leading-tight text-white">
        Phocas - Sell-Through
        <br />
        Weekly Units Sold
      </div>

      {chips.length > 0 && (
        <ul className="flex flex-wrap gap-1" data-testid="list-selected-chips">
          {chips.map((c) => (
            <li
              key={c.key}
              className="flex max-w-full items-center gap-1 rounded-[2px] bg-[#d3eef6] py-0.5 pl-1.5 pr-0.5 text-[11px] text-[#1b3a44]"
            >
              <span className="truncate">{c.label}</span>
              <button
                type="button"
                aria-label={`Remove ${c.label}`}
                onClick={c.remove}
                className="rounded-[2px] p-0.5 hover:bg-[#b5e0ee]"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className="space-y-3">
          <div className="space-y-1.5">{ACCOUNT_DIMS.map(renderDim)}</div>
          <div className="space-y-1.5">{STOCK_DIMS.map(renderDim)}</div>
        </div>
      )}
    </div>
  );
}
