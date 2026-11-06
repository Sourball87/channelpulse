import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { readProgramGrid, readProgramText } from "./program-source";
import { previewProgramRows } from "./program-table";
import { readCenterWorkbook, detectCenterKind } from "./center-parser";

const now = new Date("2026-11-06T01:00:00Z");
const accounts = ["CA", "Centrecom", "Scorptec", "PLE", "PCCG", "Umart", "KS", "DigiDirect"]
  .map((name, i) => ({ id: i + 1, name, code: name.toLowerCase() }));
const exact = `Start28-Sep
End31-Oct
Allocation
SKURRP IncGTM IncDiscountDD Std Cost ExT1 EXGTM Buy ExSTA QtySTA CostREV TOTALPart No.CACentrecomScorptecPLEPCCGUmartKSDigiDirectTotal
MZ-77E500BW$449$269-40%$307$323$232$91900$81,462$276,017MZ-77E500BW0200100100100200100100900`;
const headers = ["SKU", "RRP Inc", "GTM Inc", "Discount", "DD Std Cost Ex", "T1 EX", "GTM Buy Ex", "STA", "STA Qty", "STA Cost", "REV TOTAL", "", "Part No.",
  "CA", "Centrecom", "Scorptec", "PLE", "PCCG", "Umart", "KS", "DigiDirect", "Total"];
const values = ["MZ-77E500BW", "$449", "$269", "-40%", "$307", "$323", "$232", "$9", "1900", "$81,462", "$276,017", "", "MZ-77E500BW",
  "0", "200", "100", "100", "100", "200", "100", "100", "900"];
const totalsRow = () => {
  const row = Array(headers.length).fill("");
  for (const heading of [...accounts.map(a => a.name), "Total"]) {
    const index = headers.indexOf(heading);
    row[index] = values[index];
  }
  return row;
};
const grid = () => [
  ["Start", "28-Sep"], ["End", "31-Oct", "", "", "Allocation"], ["Allocation"], headers,
  Array(headers.length).fill(""), values, totalsRow(), Array(headers.length).fill(""),
];
const preview = (source: ReturnType<typeof readProgramText>) =>
  previewProgramRows(source.headers, source.rows, accounts, undefined, "Test program", source.meta);
describe("real program source layouts", () => {
  it("recovers the exact fully collapsed supplied table without an LLM or invented allocations", () => {
    const p = preview(readProgramText(exact, now));
    expect(p.issues.filter(i => i.blocking)).toEqual([]);
    expect(p.startDate).toBe("2026-09-28"); expect(p.endDate).toBe("2026-10-31");
    expect(p.dateNote).toContain("Year inferred");
    expect(p.rows[0]).toMatchObject({ sku: "MZ-77E500BW", rrpIncCents: 44900, gtmIncCents: 26900,
      ddCostExCents: 30700, t1ExCents: 32300, gtmBuyCents: 23200 });
    expect(p.rows[0].caps.map(c => c.quantity)).toEqual([0, 200, 100, 100, 100, 200, 100, 100]);
    expect(p.mapping.ignored).toContain("Part No.");
    expect(p.issues.some(i => i.message.includes("group-heading"))).toBe(true);
    expect(p.issues.some(i => i.message.includes("unique split"))).toBe(true);
  });
  it("reads the same Excel table with preamble, Allocation, blank column and duplicate Part No.", () => {
    const p = preview(readProgramText(grid().map(r => r.join("\t")).join("\n"), now));
    expect(p.issues.filter(i => i.blocking)).toEqual([]);
    expect(p.rows[0].sourceRow).toBe(6);
    expect(p.rows[0].caps.map(c => c.quantity)).toEqual([0, 200, 100, 100, 100, 200, 100, 100]);
    expect(p.mapping.ignored).toEqual(expect.arrayContaining(["Discount", "STA", "STA Qty", "STA Cost", "REV TOTAL", "Part No.", "Total"]));
    expect(p.ignoredColumns?.find(c => c.heading === "Part No.")?.reason).toContain("Repeats");
    expect(p.issues.some(i => i.message.includes("blank spacer"))).toBe(true);
  });
  it("takes the first date cell and lists blank and numeric-total rows without blocking", () => {
    const rows = grid();
    const p = preview(readProgramText(rows.map(r => r.join("\t")).join("\n"), now));
    expect([p.startDate, p.endDate]).toEqual(["2026-09-28", "2026-10-31"]);
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0].sourceRow).toBe(6);
    expect(p.ignoredRows).toEqual(expect.arrayContaining([
      { row: 5, reason: "Blank row." },
      { row: 7, reason: "Numeric totals row." },
      { row: 8, reason: "Blank row." },
    ]));
    expect(p.issues.filter(i => i.blocking)).toEqual([]);
    expect(p.issues.some(i => i.message.includes("Totals row does not match"))).toBe(false);

    rows[6][headers.indexOf("CA")] = "1";
    const mismatch = preview(readProgramText(rows.map(r => r.join("\t")).join("\n"), now));
    expect(mismatch.rows).toHaveLength(1);
    expect(mismatch.issues).toContainEqual(expect.objectContaining({
      row: 7, column: "Totals", blocking: false, message: expect.stringContaining("Totals row does not match column sums"),
    }));
    expect(mismatch.issues.some(i => i.blocking && /valid SKU|GTM Buy Ex is blank/.test(i.message))).toBe(false);
  });
  it("keeps first repeated headings and lists later columns as ignored", () => {
    const p = preview(readProgramText("SKU\tGTM Buy Ex\tCA\tCA\nCUSTOM\t$232\t2\t99", now));
    expect(p.rows[0].caps).toEqual([{ resellerId: 1, quantity: 2 }]);
    expect(p.mapping.ignored).toContain("CA [duplicate 2]");
    expect(p.issues.some(i => i.blocking)).toBe(false);
  });
  it("reads multiple-space separators, formatted money and customer quantities", () => {
    const p = preview(readProgramText("Start 28-Sep\nAllocation\nSKU  GTM Buy Ex  DD Std Cost Ex  T1 EX  Discount  CA  Total\nCUSTOM  $ 1,232.00  $307  $ 323  -40%  1,000  1000", now));
    expect(p.rows[0]).toMatchObject({ gtmBuyCents: 123200, ddCostExCents: 30700, t1ExCents: 32300, caps: [{ resellerId: 1, quantity: 1000 }] });
    expect(p.issues.filter(i => i.blocking)).toEqual([]);
  });
  it("flags data under a blank heading rather than silently mapping it to a customer", () => {
    const p = preview(readProgramText("SKU\tGTM Buy Ex\t\tCA\nCUSTOM\t232\t8\t2", now));
    expect(p.rows[0].caps).toEqual([{ resellerId: 1, quantity: 2 }]);
    expect(p.issues).toContainEqual(expect.objectContaining({
      row: 2, column: "Column 3", blocking: true, message: expect.stringContaining("Unheaded column contains data"),
    }));
  });
  it("joins wrapped continuation lines and permits trailing empty cells", () => {
    const p = preview(readProgramText("SKU\tGTM Buy Ex\tCA\tCentrecom\tScorptec\nCUSTOM\t$232\n0\t200\t100\t\nNEXT\t$200\t1\t0\t\t", now));
    expect(p.rows).toHaveLength(2);
    expect(p.rows[0].caps.map(c => c.quantity)).toEqual([0, 200, 100]);
    expect(p.rows[1].caps.map(c => c.quantity)).toEqual([1, 0, null]);
    expect(p.issues.filter(i => i.blocking)).toEqual([]);
    expect(p.issues.some(i => i.message.includes("Joined wrapped"))).toBe(true);
  });
  it("warns about Total mismatch without creating an all-SKU customer cap", () => {
    const p = preview(readProgramText("SKU\tGTM Buy Ex\tCA\tCentrecom\tTotal\nCUSTOM\t232\t0\t2\t9", now));
    expect(p.issues).toContainEqual(expect.objectContaining({ blocking: false, column: "Total", message: expect.stringContaining("does not match") }));
    expect(p.customerIds).toEqual([1, 2]); expect(p.rows[0].caps).toHaveLength(2);
  });
  it("retains the preview and valid rows when one row has invalid prices/caps or an unmatched customer", () => {
    const p = preview(readProgramText("SKU\tGTM Buy Ex\tCA\tUnknown customer\nGOOD\t232\t2\t3\nBAD\tno-price\t-4\t?", now));
    expect(p.rows).toHaveLength(2); expect(p.rows[0].gtmBuyCents).toBe(23200);
    expect(p.issues).toContainEqual(expect.objectContaining({ column: "Unknown customer", blocking: true }));
    expect(p.issues.some(i => i.row === 3 && i.column === "GTM Buy Ex")).toBe(true);
  });
  it("does not discard a different secondary Part No. as if it were a duplicate SKU", () => {
    const p = preview(readProgramText("SKU\tGTM Buy Ex\tPart No.\nCUSTOM\t232\tDIFFERENT", now));
    expect(p.mapping.fields.sku).toBe("SKU");
    expect(p.mapping.ignored).not.toContain("Part No.");
    expect(p.issues.some(i => i.column === "Part No." && i.blocking)).toBe(true);
  });
  it("leaves ambiguous collapsed caps blocked rather than making them unlimited", () => {
    const text = exact.replace("0200100100100200100100900", "11111111111111111111111");
    const p = preview(readProgramText(text, now));
    expect(p.rows[0].gtmBuyCents).toBe(23200);
    expect(p.issues.some(i => i.blocking && i.message.includes("ambiguous"))).toBe(true);
  });
  it("infers a sensible cross-year period and preserves supplied explicit years", () => {
    const p = preview(readProgramText("Start 28-Dec\nEnd 31-Jan\nSKU\tGTM Buy Ex\nCUSTOM\t232", new Date("2027-01-15T12:00:00Z")));
    expect([p.startDate, p.endDate]).toEqual(["2026-12-28", "2027-01-31"]);
    const explicit = preview(readProgramText("Start 28-Sep-2025\nEnd 31-Oct-2025\nSKU\tGTM Buy Ex\nCUSTOM\t232", now));
    expect([explicit.startDate, explicit.endDate, explicit.dateNote]).toEqual(["2025-09-28", "2025-10-31", null]);
  });
  it("uses the same normalization for dropped CSV and XLSX program files", () => {
    const csv = grid().map(r => r.map(v => `"${v.replace(/"/g, '""')}"`).join(",")).join("\n");
    const parsed = readCenterWorkbook(Buffer.from(csv));
    expect(parsed.programSources.Sheet1.startDate).toMatch(/-09-28$/);
    expect(detectCenterKind(Object.keys(parsed.sheets.Sheet1[0]))).toBe("program");
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(grid()), "Offer");
    const file = readCenterWorkbook(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    expect(file.programSources.Offer.ignoredRows).toContainEqual({ row: 5, reason: "Blank row." });
    expect(file.programSources.Offer.ignoredRows).toContainEqual({ row: 7, reason: "Numeric totals row." });
    const p = previewProgramRows(Object.keys(file.sheets.Offer[0]), file.sheets.Offer, accounts, undefined, "Offer", file.programSources.Offer);
    expect(p.rows[0].caps.map(c => c.quantity)).toEqual([0, 200, 100, 100, 100, 200, 100, 100]);
    expect(p.mapping.ignored).toContain("Part No.");
    expect(p.issues.filter(i => i.blocking)).toEqual([]);
  });
  it("reads preambles with Excel numeric dates", () => {
    const source = readProgramGrid([["Start", 46293], ["SKU", "GTM Buy Ex"], ["CUSTOM", 232]], now);
    expect(source.meta.startDate).toBe("2026-09-28");
  });
});
