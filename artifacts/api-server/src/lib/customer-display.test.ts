import { describe, expect, it } from "vitest";
import { maskCustomerDisplay, maskCustomerText } from "./customer-display";

describe("customer display masking", () => {
  it("uses the requested nine abbreviations in labels and embedded text", () => {
    expect(maskCustomerText("Computer Alliance, Centrecom, Scorptec, PLE Computers, PCCG, Umart, KS Computer Tech, JW Computers, DigiDirect"))
      .toBe("CA, CC, SC, PL, PC, UM, KS, JW, DI");
    expect(maskCustomerText("Scorptec_report.csv — send to DigiDirect")).toBe("SC_report.csv — send to DI");
    expect(maskCustomerText("COMPUTERALLIANCE and PC Case Gear")).toBe("CA and PC");
    expect(maskCustomerText("computer_alliance.xlsx and PCCaseGear.csv")).toBe("CA.xlsx and PC.csv");
  });
  it("preserves machine identifiers and source matching rules", () => {
    const source = {
      name: "Umart", code: "umart", reseller_name: "Scorptec",
      aliases: ["Umart"], filename_patterns: ["Umart.*"],
      mapping: { sku: "PLE Stock Code" }, headers: ["PLE Stock Code"],
      rows: [{ sku: "UMART", serial: "SCORPTEC", source: "Umart_2026.xlsx", accountCode: "umart" }],
    };
    expect(maskCustomerDisplay(source)).toEqual({
      ...source, name: "UM", reseller_name: "SC",
      rows: [{ ...source.rows[0], source: "UM_2026.xlsx" }],
    });
    expect(source.name).toBe("Umart");
  });
  it("keeps dates intact and labels known accounts regardless of legal-name suffixes", () => {
    const date = new Date("2026-09-01T00:00:00.000Z");
    expect(maskCustomerDisplay({ code: "ca", name: "Computer Alliance Pty Ltd", created_at: date }))
      .toEqual({ code: "ca", name: "CA", created_at: date });
  });
});
