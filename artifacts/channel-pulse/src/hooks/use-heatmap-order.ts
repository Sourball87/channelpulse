import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetPartsQueryKey,
  useGetParts,
  useResetPartOrder,
  useUpdatePartOrder,
} from "@workspace/api-client-react";

export const DEFAULT_PART_ORDER: string[] = [];
export const DEFAULT_RESELLER_ORDER: string[] = ["CA", "centrecom", "scorptec", "ple", "pccg", "umart", "ks", "jw", "digi"];

export function sortByOrder(items: string[], order: string[]): string[] {
  const positions = new Map(order.map((value, index) => [value.toLowerCase(), index]));
  return [...items].sort((a, b) => (positions.get(a.toLowerCase()) ?? Infinity) - (positions.get(b.toLowerCase()) ?? Infinity));
}

function reorderArray(items: string[], from: string, to: string): string[] {
  const next = [...items];
  const fromIndex = next.findIndex((value) => value.toLowerCase() === from.toLowerCase());
  const toIndex = next.findIndex((value) => value.toLowerCase() === to.toLowerCase());
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return items;
  next.splice(fromIndex, 1);
  next.splice(toIndex, 0, from);
  return next;
}

/** SKU order is sourced from the server; only the uncommitted draft is local. */
export function useHeatmapOrder() {
  const { data: parts = [] } = useGetParts();
  const queryClient = useQueryClient();
  const updateOrder = useUpdatePartOrder();
  const resetOrder = useResetPartOrder();
  const [draftPartOrder, setDraftPartOrder] = useState<string[]>([]);
  const [draftActive, setDraftActive] = useState(false);
  const [resellerOrder, setResellerOrder] = useState<string[]>(DEFAULT_RESELLER_ORDER);
  const [draftResellerOrder, setDraftResellerOrder] = useState<string[]>(DEFAULT_RESELLER_ORDER);
  const partOrder = useMemo(() => [...parts].sort((a, b) => a.sort_order - b.sort_order).map((part) => part.part_no), [parts]);
  const isEditing = draftActive;

  const startEditing = useCallback(() => {
    setDraftPartOrder(partOrder);
    setDraftResellerOrder(resellerOrder);
    setDraftActive(true);
  }, [partOrder, resellerOrder]);
  const reorderPart = useCallback((from: string, to: string) => {
    setDraftPartOrder((current) => reorderArray(current, from, to));
  }, []);
  const cancelEditing = useCallback(() => {
    setDraftPartOrder(partOrder);
    setDraftResellerOrder(resellerOrder);
    setDraftActive(false);
  }, [partOrder, resellerOrder]);
  const commitOrder = useCallback(() => {
    const orderedIds = [...parts]
      .sort((a, b) => a.sort_order - b.sort_order)
      .sort((a, b) => {
        const ai = draftPartOrder.indexOf(a.part_no);
        const bi = draftPartOrder.indexOf(b.part_no);
        return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
      })
      .map((part) => part.id);
    if (!orderedIds.length) return;
    updateOrder.mutate({ data: { part_ids: orderedIds } }, {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getGetPartsQueryKey() });
        setDraftActive(false);
      },
    });
  }, [parts, draftPartOrder, updateOrder, queryClient]);
  const resetToDefaults = useCallback(() => {
    resetOrder.mutate(undefined, {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getGetPartsQueryKey() });
        setDraftActive(false);
      },
    });
  }, [resetOrder, queryClient]);
  const reorderReseller = useCallback((from: string, to: string) => {
    setDraftResellerOrder((current) => reorderArray(current, from, to));
  }, []);

  return {
    partOrder,
    resellerOrder,
    draftPartOrder,
    draftResellerOrder,
    isEditing,
    isSaving: updateOrder.isPending || resetOrder.isPending,
    startEditing,
    commitOrder,
    cancelEditing,
    resetToDefaults,
    reorderPart,
    reorderReseller,
  };
}
