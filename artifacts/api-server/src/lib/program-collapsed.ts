/** Recovery is restricted to source tokens and a UNIQUE allocation split
 * satisfying the supplied Total. Ambiguity never becomes unlimited caps. */
const names = [
  "DD Std Cost Ex", "DD Cost Ex", "GTM Buy Ex", "STA Qty", "STA Cost", "REV TOTAL", "Stock Code",
  "Part No.", "Part Number", "RRP Inc", "GTM Inc", "T1 EX", "Discount",
  "Centrecom", "Scorptec", "DigiDirect", "Amazon", "PCCG", "Umart", "Total", "SKU", "STA", "PLE", "CA", "KS",
];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ +/g, "\\s*");
const token = new RegExp(names.sort((a, b) => b.length - a.length).map(escape).join("|"), "gi");
export function collapsedHeadings(text: string): string[] {
  const found: string[] = [];
  let end = 0;
  for (const m of text.matchAll(token)) {
    if (m.index! > end && text.slice(end, m.index).trim()) found.push(text.slice(end, m.index).trim());
    found.push(m[0].trim()); end = m.index! + m[0].length;
  }
  if (text.slice(end).trim()) found.push(text.slice(end).trim());
  return found;
}
function capSplit(text: string, count: number): string[] | null {
  if (!/^\d+$/.test(text) || count < 1 || count > 30 || text.length > (count + 1) * 7) return null;
  const answers: string[][] = [];
  let visits = 0, exhausted = false;
  for (let width = 1; width <= Math.min(9, text.length - count); width++) {
    const totalText = text.slice(-width), target = +totalText;
    if ((width > 1 && totalText.startsWith("0")) || target > count * 1_000_000) continue;
    const body = text.slice(0, -width);
    const search = (offset: number, left: number, sum: number, values: string[]) => {
      if (++visits > 20000) { exhausted = true; return; }
      if (answers.length > 1 || exhausted) return;
      if (!left) { if (offset === body.length && sum === target) answers.push([...values, totalText]); return; }
      if (body.length - offset < left || body.length - offset > left * 7) return;
      for (let n = 1; n <= Math.min(7, body.length - offset - left + 1); n++) {
        const value = body.slice(offset, offset + n);
        if (n > 1 && value[0] === "0") break;
        if (+value > 1_000_000 || sum + +value > target) break;
        search(offset + n, left - 1, sum + +value, [...values, value]);
      }
    };
    search(0, count, 0, []);
    if (exhausted || answers.length > 1) return null;
  }
  return answers.length === 1 ? answers[0] : null;
}
export function collapsedRow(text: string, headers: string[]): { cells: string[]; recovered: boolean; warning: string | null } {
  const firstMoney = text.indexOf("$");
  if (firstMoney < 1) return { cells: [text], recovered: false, warning: "Row has no reliable cell separators; its columns could not be recovered." };
  const sku = text.slice(0, firstMoney).trim();
  const duplicate = text.indexOf(sku, firstMoney);
  const duplicateCol = headers.findIndex((h, i) => i > 0 && /^(part\s*no\.?|part\s*number|sku)$/i.test(h));
  const boundary = duplicate >= 0 ? duplicate : text.length;
  const values = text.slice(firstMoney, boundary).match(/\$-?[\d,]+(?:\.\d{1,2})?|-?\d+(?:\.\d+)?%/g) ?? [];
  const cells = [sku, ...values];
  if (duplicateCol < 0 || duplicate < 0 || cells.length !== duplicateCol)
    return { cells, recovered: false, warning: "Some collapsed columns could not be separated reliably; review the source row." };
  cells.push(sku);
  const tail = text.slice(duplicate + sku.length).trim();
  const lastIsTotal = /^total$/i.test(headers.at(-1) ?? "");
  const split = lastIsTotal ? capSplit(tail, headers.length - duplicateCol - 2) : null;
  if (split) return { cells: [...cells, ...split], recovered: true, warning: "Recovered collapsed customer caps using the unique split matching the source Total. Review the allocations." };
  return { cells: [...cells, ...Array(headers.length - cells.length).fill("UNRESOLVED")], recovered: false,
    warning: "Collapsed customer caps are ambiguous or do not match Total. Restore separators for this row; no caps were guessed." };
}
