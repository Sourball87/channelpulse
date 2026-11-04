import { useState } from "react";
import { ArrowLeft, ArrowRight, GripVertical, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ALL_METRICS, METRIC_INFO, METRIC_PRESETS, addMetric, isStockMetric, moveMetric, removeMetric, sameMetrics,
  type StockMetric,
} from "@/lib/metric-selection";

const MIME = "application/x-channelpulse-metric";
type Payload = { metric: StockMetric; from: "source" | "selected" };

function readPayload(e: React.DragEvent): Payload | null {
  try {
    const raw = e.dataTransfer.getData(MIME) || e.dataTransfer.getData("text/plain");
    const p = JSON.parse(raw);
    return isStockMetric(p?.metric) ? { metric: p.metric, from: p.from === "selected" ? "selected" : "source" } : null;
  } catch { return null; }
}

const tone: Record<StockMetric, string> = {
  st: "border-amber-300 bg-amber-50 text-amber-900",
  soh: "border-sky-300 bg-sky-50 text-sky-900",
};

export function MetricPicker({ metrics, update }: {
  metrics: StockMetric[];
  update: (fn: (prev: StockMetric[]) => StockMetric[]) => void;
}) {
  const [over, setOver] = useState<number | null>(null);
  const [announce, setAnnounce] = useState("");

  const start = (e: React.DragEvent, p: Payload) => {
    const json = JSON.stringify(p);
    e.dataTransfer.setData(MIME, json);
    e.dataTransfer.setData("text/plain", json);
    e.dataTransfer.effectAllowed = "move";
  };
  const drop = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(null);
    const p = readPayload(e);
    if (!p) return;
    update(prev => {
      if (!prev.includes(p.metric)) return addMetric(prev, p.metric, index);
      // Dropping onto another chip moves to that chip's position; the open
      // area after the chips moves to the end.
      return moveMetric(prev, p.metric, Math.min(index, prev.length - 1));
    });
    setAnnounce(`${METRIC_INFO[p.metric].short} placed in position ${index + 1}`);
  };
  const allowDrop = (e: React.DragEvent, index: number) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOver(index); };

  return (
    <div className="rounded-md border bg-muted/20 p-3 mb-3 space-y-2" data-testid="metric-picker">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground w-16">Metrics</span>
        {ALL_METRICS.map(metric => {
          const active = metrics.includes(metric);
          return (
            <button
              key={metric}
              type="button"
              draggable
              onDragStart={e => start(e, { metric, from: "source" })}
              onClick={() => { update(prev => addMetric(prev, metric)); setAnnounce(`${METRIC_INFO[metric].short} added`); }}
              disabled={active}
              aria-label={active ? `${METRIC_INFO[metric].long} already shown` : `Add ${METRIC_INFO[metric].long} column`}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold cursor-grab active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 disabled:cursor-not-allowed ${tone[metric]}`}
              data-testid={`chip-source-${metric}`}
            >
              {active ? null : <Plus className="h-3 w-3" aria-hidden="true" />}
              {METRIC_INFO[metric].short}
              <span className="font-normal opacity-70">{METRIC_INFO[metric].unit}</span>
            </button>
          );
        })}
        <div className="ml-auto flex flex-wrap gap-1" role="group" aria-label="Metric presets">
          {METRIC_PRESETS.map(preset => {
            const pressed = sameMetrics(metrics, preset.metrics);
            return (
              <Button
                key={preset.id}
                variant={pressed ? "secondary" : "ghost"}
                size="sm"
                className="h-7 px-2 text-xs"
                aria-pressed={pressed}
                onClick={() => { update(() => [...preset.metrics]); setAnnounce(`${preset.label} view`); }}
                data-testid={`button-preset-${preset.id}`}
              >{preset.label}</Button>
            );
          })}
        </div>
      </div>

      <div
        className={`flex flex-wrap items-center gap-1 min-h-10 rounded-md border-2 border-dashed px-2 py-1.5 transition-colors ${over !== null ? "border-primary bg-primary/5" : "border-muted-foreground/25 bg-background"}`}
        onDragOver={e => allowDrop(e, metrics.length)}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null); }}
        onDrop={e => drop(e, metrics.length)}
        aria-label="Selected table metrics"
        data-testid="dropzone-metrics"
      >
        <span className="text-xs font-medium text-muted-foreground w-14 shrink-0">Columns</span>
        {!metrics.length && (
          <span className="text-xs text-muted-foreground">Drag ST or SOH here, or click a chip or preset, to build the table.</span>
        )}
        {metrics.map((metric, index) => (
          <div
            key={metric}
            draggable
            onDragStart={e => start(e, { metric, from: "selected" })}
            onDragOver={e => { e.stopPropagation(); allowDrop(e, index); }}
            onDrop={e => drop(e, index)}
            className={`inline-flex items-center gap-0.5 rounded-md border pl-1 pr-0.5 py-0.5 text-xs font-semibold cursor-grab active:cursor-grabbing ${tone[metric]} ${over === index ? "ring-2 ring-primary" : ""}`}
            data-testid={`chip-selected-${metric}`}
          >
            <GripVertical className="h-3.5 w-3.5 opacity-50" aria-hidden="true" />
            <span className="px-0.5">{index + 1}. {METRIC_INFO[metric].short}</span>
            <button type="button" className="rounded p-0.5 hover:bg-black/10 disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              disabled={index === 0} aria-label={`Move ${METRIC_INFO[metric].short} left`}
              onClick={() => update(prev => moveMetric(prev, metric, index - 1))} data-testid={`button-move-left-${metric}`}>
              <ArrowLeft className="h-3 w-3" />
            </button>
            <button type="button" className="rounded p-0.5 hover:bg-black/10 disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              disabled={index === metrics.length - 1} aria-label={`Move ${METRIC_INFO[metric].short} right`}
              onClick={() => update(prev => moveMetric(prev, metric, index + 1))} data-testid={`button-move-right-${metric}`}>
              <ArrowRight className="h-3 w-3" />
            </button>
            <button type="button" className="rounded p-0.5 hover:bg-black/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Remove ${METRIC_INFO[metric].short} column`}
              onClick={() => { update(prev => removeMetric(prev, metric)); setAnnounce(`${METRIC_INFO[metric].short} removed`); }}
              data-testid={`button-remove-${metric}`}>
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
      <p className="sr-only" aria-live="polite">{announce}</p>
    </div>
  );
}
