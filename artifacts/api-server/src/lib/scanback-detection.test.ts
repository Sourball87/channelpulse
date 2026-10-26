import { describe, expect, it } from "vitest";
import { detectImportKind } from "./scanback-import";
import { prontoMapping } from "./scanback-pronto";

describe("automatic scanback spreadsheet type detection", () => {
  it("recognizes native Pronto invoice/credit evidence", () => {
    expect(detectImportKind([...Object.values(prontoMapping).filter(Boolean), "Reseller Name", "Line Price Ex"])).toBe("evidence");
  });
  it("recognizes generic evidence independently of file names and prices", () => {
    expect(detectImportKind(["Serial", "SKU", "Invoice", "Invoice Date", "Quantity", "Unit Price"])).toBe("evidence");
  });
  it("recognizes historical approvals without treating them as new customer claims", () => {
    expect(detectImportKind(["Serial", "SKU", "Date", "Amount", "Promotion", "Claim Reference"])).toBe("history");
  });
  it("recognizes customer serial reports", () => {
    expect(detectImportKind(["Serial Number", "SKU", "Sale Date"])).toBe("claim");
    expect(detectImportKind(["Serial"])).toBe("claim");
  });
  it("asks for a manual type for mixed or incomplete financial layouts", () => {
    expect(() => detectImportKind(["Serial", "Invoice", "Quantity", "Unit Price", "Amount", "Promotion", "Claim Reference"])).toThrow("explicitly");
    expect(() => detectImportKind(["Serial", "Invoice", "Date"])).toThrow("confidently");
    expect(() => detectImportKind(["Serial", "Amount"])).toThrow("confidently");
  });
});
