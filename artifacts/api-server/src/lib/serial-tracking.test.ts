import { describe, expect, it } from "vitest";
import type { ScanbackImport } from "@workspace/api-zod";
import { reportedSales, firstReportedSales, earlierReportReason, isSameCustomerReportRepeat } from "./serial-tracking";

function report(id: string, committedAt: string, overrides: Partial<ScanbackImport> = {}): ScanbackImport {
  return {
    id, name: id + ".csv", kind: "claim", state: "committed", committedAt,
    createdAt: "2026-01-01T00:00:00.000Z", headers: [], sheets: ["Sheet1"], sheet: "Sheet1",
    mapping: {}, dateFormat: "dmy", accountId: 1, errors: [], warnings: [], duplicate: false, recordCount: 1,
    rows: [{ rowIndex: 0, serial: "SER001", sku: "SKU", date: "2026-09-20", accountId: 1, quantity: 1,
      invoice: "", unitPriceCents: null, amountCents: null, program: "", reference: "" }], ...overrides,
  };
}
describe("global sold-serial source ordering", () => {
  it("uses first commit, not backdated sale/upload dates, across customers", () => {
    const first = report("first", "2026-09-22T00:00:00.000Z", { createdAt: "2026-09-21T00:00:00.000Z" });
    const later = report("later", "2026-09-23T00:00:00.000Z", { accountId: 2, createdAt: "2026-09-01T00:00:00.000Z" });
    const sales = reportedSales([later, first]);
    const original = firstReportedSales(sales).get("SER001");
    expect(original?.reportId).toBe("first");
    expect(earlierReportReason(original, "first", 0)).toBe("");
    expect(earlierReportReason(original, "later", 0)).toContain("first.csv [first]");
  });
  it("never reserves a serial from an unconfirmed preview", () => {
    expect(reportedSales([report("staged", "", { state: "preview" })])).toEqual([]);
  });
  it("blocks repeated rows inside the same source without blocking its first row", () => {
    const source = report("first", "2026-09-22T00:00:00.000Z");
    source.rows.push({ ...source.rows[0], rowIndex: 1 });
    const first = firstReportedSales(reportedSales([source])).get("SER001");
    expect(earlierReportReason(first, source.id, 0)).toBe("");
    expect(earlierReportReason(first, source.id, 1)).toContain("row 2");
  });
  it("treats same-customer report repeats as verifiable and omits superseded reports", () => {
    const original = report("original", "2026-09-22T00:00:00.000Z");
    const resend = report("resend", "2026-09-23T00:00:00.000Z");
    const superseded = report("superseded", "2026-09-24T00:00:00.000Z", { state: "superseded" });
    const first = firstReportedSales(reportedSales([original, resend, superseded])).get("SER001");
    const sameCustomer = earlierReportReason(first, "resend", 0, 1);
    expect(sameCustomer).toContain("Also in earlier report original.csv");
    expect(isSameCustomerReportRepeat(sameCustomer)).toBe(true);
    const crossCustomer = earlierReportReason(first, "resend", 0, 2);
    expect(crossCustomer).toContain("Already reported sold in original.csv");
    expect(isSameCustomerReportRepeat(crossCustomer)).toBe(false);
    expect(reportedSales([superseded])).toEqual([]);
  });
  it("supports legacy committed reports and normalizes serials without deleting leading zeros", () => {
    const source = report("legacy", "", { committedAt: undefined });
    source.rows[0].serial = " 00sn 001 ";
    const sale = reportedSales([source])[0];
    expect(sale.serial).toBe("00SN001");
    expect(sale.committedAt).toBe(source.createdAt);
  });
});
