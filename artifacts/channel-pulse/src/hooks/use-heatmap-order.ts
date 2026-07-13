import { useState, useCallback } from "react";

// ─── Defaults extracted from reference screenshot ─────────────────────────────

export const DEFAULT_PART_ORDER: string[] = [
  "MZ-77E250BW",
  "MZ-77E500BW",
  "MZ-77E1T0BW",
  "MZ-77E2T0BW",
  "MZ-77E4T0BW",
  "MZ-77E8T0BW",
  "MZ-V9V1T0BW",
  "MZ-V9V2T0BW",
  "MZ-V9S1T0BW",
  "MZ-V9S2T0BW",
  "MZ-V9S4T0BW",
  "MZ-V9P1T0BW",
  "MZ-V9P2T0BW",
  "MZ-V9P4T0BW",
  "MZ-V9P1T0CW",
  "MZ-V9P2T0CW",
  "MZ-V9P4T0CW",
  "MZ-VAP1T0BW",
  "MZ-VAP2T0BW",
  "MZ-VAP4T0BW",
  "MZ-VAP8T0BW",
  "MZ-VAP1T0CW",
  "MZ-VAP2T0CW",
  "MZ-VAP4T0CW",
  "MZ-VAP8T0CW",
];

// Ordered by reseller code (case-insensitive match)
export const DEFAULT_RESELLER_ORDER: string[] = [
  "CA",
  "centrecom",
  "scorptec",
  "ple",
  "pccg",
  "umart",
  "ks",
  "jw",
  "digi",
];

const LS_PARTS_KEY = "channel-pulse:heatmap-part-order";
const LS_RESELLERS_KEY = "channel-pulse:heatmap-reseller-order";

function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    // ignore
  }
  return fallback;
}

function saveToStorage<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

// ─── Sort helpers ─────────────────────────────────────────────────────────────

/** Sort `items` by their position in `order` (case-insensitive). Unknown items append at the end. */
export function sortByOrder(items: string[], order: string[]): string[] {
  const orderMap = new Map(order.map((v, i) => [v.toLowerCase(), i]));
  return [...items].sort((a, b) => {
    const ai = orderMap.get(a.toLowerCase()) ?? Infinity;
    const bi = orderMap.get(b.toLowerCase()) ?? Infinity;
    return ai - bi;
  });
}

function reorderArray(arr: string[], fromItem: string, toItem: string): string[] {
  const next = [...arr];
  const fromIdx = next.findIndex(v => v.toLowerCase() === fromItem.toLowerCase());
  const toIdx = next.findIndex(v => v.toLowerCase() === toItem.toLowerCase());
  if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return arr;
  next.splice(fromIdx, 1);
  next.splice(toIdx, 0, fromItem);
  return next;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useHeatmapOrder() {
  const [partOrder, setPartOrder] = useState<string[]>(() =>
    loadFromStorage(LS_PARTS_KEY, DEFAULT_PART_ORDER)
  );
  const [resellerOrder, setResellerOrder] = useState<string[]>(() =>
    loadFromStorage(LS_RESELLERS_KEY, DEFAULT_RESELLER_ORDER)
  );

  // Working copies while in edit mode (not yet committed to storage)
  const [draftPartOrder, setDraftPartOrder] = useState<string[]>(partOrder);
  const [draftResellerOrder, setDraftResellerOrder] = useState<string[]>(resellerOrder);

  const [isEditing, setIsEditing] = useState(false);

  const startEditing = useCallback(() => {
    setDraftPartOrder(partOrder);
    setDraftResellerOrder(resellerOrder);
    setIsEditing(true);
  }, [partOrder, resellerOrder]);

  const commitOrder = useCallback(() => {
    setPartOrder(draftPartOrder);
    setResellerOrder(draftResellerOrder);
    saveToStorage(LS_PARTS_KEY, draftPartOrder);
    saveToStorage(LS_RESELLERS_KEY, draftResellerOrder);
    setIsEditing(false);
  }, [draftPartOrder, draftResellerOrder]);

  const cancelEditing = useCallback(() => {
    setDraftPartOrder(partOrder);
    setDraftResellerOrder(resellerOrder);
    setIsEditing(false);
  }, [partOrder, resellerOrder]);

  const resetToDefaults = useCallback(() => {
    setDraftPartOrder(DEFAULT_PART_ORDER);
    setDraftResellerOrder(DEFAULT_RESELLER_ORDER);
  }, []);

  const reorderPart = useCallback((from: string, to: string) => {
    setDraftPartOrder(prev => reorderArray(prev, from, to));
  }, []);

  const reorderReseller = useCallback((from: string, to: string) => {
    setDraftResellerOrder(prev => reorderArray(prev, from, to));
  }, []);

  return {
    // Active (committed) order — use for display
    partOrder,
    resellerOrder,
    // Draft order — use while editing
    draftPartOrder,
    draftResellerOrder,
    isEditing,
    startEditing,
    commitOrder,
    cancelEditing,
    resetToDefaults,
    reorderPart,
    reorderReseller,
  };
}
