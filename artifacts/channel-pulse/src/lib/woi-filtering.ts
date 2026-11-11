type WoiRow = {
  channel_total: {
    soh: number | null;
  };
};

export function filterWoiRows<T extends WoiRow>(rows: T[], hideZeroSoh: boolean): T[] {
  const visible = hideZeroSoh
    ? rows.filter((row) => row.channel_total.soh !== 0)
    : rows;
  return [...visible];
}
