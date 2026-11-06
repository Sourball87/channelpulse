import { describe, expect, it } from "vitest";
import { applyProgramSuggestions, mapProgramHeadings, matchProgramAccount, previewProgramRows, readPastedProgram, validateProgramReferences } from "./program-table";
import type { ScanbackProgramLine } from "@workspace/api-zod";

const accounts = [
  { id: 1, code: "ca", name: "Computer Alliance", aliases: [] },
  { id: 2, code: "centrecom", name: "Centrecom", aliases: [] },
  { id: 3, code: "scorptec", name: "Scorptec", aliases: [] },
  { id: 4, code: "ple", name: "PLE Computers", aliases: [] },
];
describe("program table ingestion", () => {
  it("maps pasted Excel amounts and customer caps without inventing missing values", () => {
    const source = readPastedProgram(
      "SKU\tRRP Inc\tGTM Inc\tDiscount\tDD Cost Ex\tT1 Ex\tGTM Buy Ex\tCA\tCentrecom\tScorptec\tPLE\n" +
      "MZ-TEST\t$110.00\t99.00\t10%\t60.01\t85.25\t70.25\t5\t0\t\t\n",
    );
    const preview = previewProgramRows(source.headers, source.rows, accounts);
    expect(preview.issues).toEqual([]);
    expect(preview.customerIds).toEqual([1, 2, 3, 4]);
    expect(preview.mapping.ignored).toEqual(["Discount"]);
    expect(preview.rows[0]).toMatchObject({
      sku: "MZ-TEST", rrpIncCents: 11000, gtmIncCents: 9900, ddCostExCents: 6001, t1ExCents: 8525, gtmBuyCents: 7025,
      caps: [{ resellerId: 1, quantity: 5 }, { resellerId: 2, quantity: 0 }, { resellerId: 3, quantity: null }, { resellerId: 4, quantity: null }],
    });
  });
  it("keeps only explicitly supplied prices; blank reference data stays null", () => {
    const source = readPastedProgram("SKU,GTM Buy Ex,CA\nCUSTOM,70,\n");
    const preview = previewProgramRows(source.headers, source.rows, accounts);
    expect(preview.issues).toEqual([]);
    expect(preview.rows[0]).toMatchObject({ rrpIncCents: null, gtmIncCents: null, ddCostExCents: null, t1ExCents: null, gtmBuyCents: 7000 });
  });
  it("matches codes, masked labels and full names uniquely, not substrings", () => {
    expect(matchProgramAccount("CC", accounts)).toBe(2);
    expect(matchProgramAccount("Computer Alliance cap", accounts)).toBe(1);
    expect(matchProgramAccount("Scorptec", accounts)).toBe(3);
    expect(matchProgramAccount("PLE", accounts)).toBe(4);
    expect(matchProgramAccount("Total of SKU caps", accounts)).toBeNull();
    expect(matchProgramAccount("Another reseller", accounts)).toBeNull();
  });
  it("highlights unknown columns until explicitly mapped or ignored", () => {
    const source = readPastedProgram("SKU\tGTM Buy Ex\tMystery customer\nCUSTOM\t70\t4");
    const before = previewProgramRows(source.headers, source.rows, accounts);
    expect(before.issues).toContainEqual(expect.objectContaining({ column: "Mystery customer", blocking: true }));
    const mapping = { ...before.mapping, customers: { "Mystery customer": 1 } };
    expect(previewProgramRows(source.headers, source.rows, accounts, mapping).issues).toEqual([]);
    expect(previewProgramRows(source.headers, source.rows, accounts, { ...before.mapping, ignored: ["Mystery customer"] }).issues).toEqual([]);
  });
  it("rejects duplicate SKU rows, fractional/negative caps and invalid prices", () => {
    const source = readPastedProgram("SKU\tGTM Buy Ex\tCA\nTEST\t70.001\t-1\nTEST\t70\t1.5");
    const preview = previewProgramRows(source.headers, source.rows, accounts);
    expect(preview.issues.some(i => i.message.includes("Duplicate SKU"))).toBe(true);
    expect(preview.issues.filter(i => i.message.includes("Caps must")).length).toBe(2);
    expect(preview.issues.some(i => i.column === "GTM Buy Ex" && i.blocking)).toBe(true);
  });
  it("rejects invalid mapping fields, columns, identities and duplicate customers", () => {
    const headers = ["SKU", "GTM Buy Ex", "CA", "Other"];
    const mapping = { fields: { sku: "SKU", unknown: "Invented" }, customers: { CA: 1, Other: 1 }, ignored: ["SKU"] };
    const preview = previewProgramRows(headers, [{ SKU: "TEST", "GTM Buy Ex": "70" }], accounts, mapping);
    expect(preview.issues.some(i => i.message.includes("supported field"))).toBe(true);
    expect(preview.issues.some(i => i.message.includes("more than once"))).toBe(true);
    expect(preview.issues.some(i => i.message.includes("assigned only once"))).toBe(true);
    expect(previewProgramRows(["SKU"], [{ SKU: "X" }], accounts,
      { fields: { sku: "SKU" }, customers: { Invented: 999 }, ignored: [] }).issues.some(i => i.blocking)).toBe(true);
  });
  it("validates metadata-only AI proposals without accepting invented fields or customers", () => {
    const headers = ["SKU", "GTM Buy Ex", "Retail offer inclusive", "Ctrcm"];
    const base = mapProgramHeadings(headers, accounts);
    const proposal = applyProgramSuggestions(base, headers, accounts, {
      fields: { sku: "Invented", gtmIncCents: "Retail offer inclusive", amount: "GTM Buy Ex" },
      customers: { Ctrcm: 2, Fake: 888 }, rows: [{ cap: 100000, price: 10 }],
    });
    expect(proposal.fields.sku).toBe("SKU");
    expect(proposal.fields.gtmIncCents).toBe("Retail offer inclusive");
    expect(proposal.fields.amount).toBeUndefined();
    expect(proposal.customers).toEqual({ Ctrcm: 2 });
    expect((proposal as unknown as { rows?: unknown }).rows).toBeUndefined();
  });
  it("rejects malformed or ambiguous pasted rectangles", () => {
    expect(() => readPastedProgram("SKU\tSKU\nA\tB")).toThrow("distinct");
    expect(() => readPastedProgram("SKU\tCA\nA\t1\t2")).toThrow("column counts");
    expect(() => readPastedProgram("")).toThrow("Paste a table");
  });
  it("allows old programs with absent reference fields but rejects unsafe money", () => {
    const line: ScanbackProgramLine = { sku: "CUSTOM", gtmBuyCents: 7000, caps: [] };
    expect(validateProgramReferences(line)).toBe(true);
    expect(validateProgramReferences({ ...line, rrpIncCents: null, ddCostExCents: 0, t1ExCents: 8025 })).toBe(true);
    expect(validateProgramReferences({ ...line, rrpIncCents: -1 })).toBe(false);
    expect(validateProgramReferences({ ...line, gtmIncCents: 1.2 })).toBe(false);
  });
});
