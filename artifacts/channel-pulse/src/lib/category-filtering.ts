export const EXCLUDED_CATEGORY = "HDD & Memory";

export interface CategorizedPart {
  id: number;
  category: string;
}

export function isSelectableCategory(category: string | null | undefined): category is string {
  return Boolean(category && category !== EXCLUDED_CATEGORY);
}

export function readCategoryFilter(search: string): string | undefined {
  const value = new URLSearchParams(search).get("category")?.trim();
  return isSelectableCategory(value) ? value : undefined;
}

export function writeCategoryFilter(params: URLSearchParams, category: string | null | undefined): void {
  if (isSelectableCategory(category)) params.set("category", category);
  else params.delete("category");
}

export function listSelectableCategories(parts: readonly Pick<CategorizedPart, "category">[]): string[] {
  return Array.from(new Set(parts.map((part) => part.category).filter(isSelectableCategory)))
    .sort((a, b) => a.localeCompare(b));
}

export function filterStockCodeParts<T extends CategorizedPart>(
  parts: readonly T[],
  category: string | undefined,
  selectedPartIds: readonly number[] = [],
): T[] {
  if (!category) return [...parts];
  const selected = new Set(selectedPartIds);
  return parts.filter((part) => part.category === category || selected.has(part.id));
}

export function keepCategoryCompatiblePartIds(
  parts: readonly CategorizedPart[],
  selectedPartIds: readonly number[],
  category: string | null,
): number[] {
  if (!category || selectedPartIds.length === 0) return [...selectedPartIds];
  const partById = new Map(parts.map((part) => [part.id, part]));
  return selectedPartIds.every((id) => partById.get(id)?.category === category)
    ? [...selectedPartIds]
    : [];
}
