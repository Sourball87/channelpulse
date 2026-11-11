export function sellThroughRedirectTarget(search: string): string {
  const query = search.replace(/^\?/, "");
  return `/sell-through${query ? `?${query}` : ""}`;
}
