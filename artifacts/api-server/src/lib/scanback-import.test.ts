import { describe, expect, it } from "vitest";
import type { ScanbackImport } from "@workspace/api-zod";
import { filterFullHistorySerialRows, mapImport, suggestMapping } from "./scanback-import";

describe("serial report ingestion", () => {
  it("keeps the detected week and unseen history while counting known older rows", () => {
    const rows = [
      { Serial: "CURR-A", SaleDate: "2026-11-02" },
      { Serial: "CURR-B", SaleDate: "2026-11-03" },
      { Serial: "CURR-C", SaleDate: "2026-11-04" },
      { Serial: "OLD-KNOWN", SaleDate: "2026-10-28" },
      { Serial: "OLD-NEW", SaleDate: "2026-10-27" },
      { Serial: "OLD-NEW", SaleDate: "2026-10-20" },
    ];
    const result = filterFullHistorySerialRows(rows, { serial: "Serial", date: "SaleDate" },
      ["CURR-A", "CURR-B", "CURR-C", "OLD-KNOWN"], "2026-W44");

    expect(result.weekIso).toBe("2026-W45");
    expect(result.contentWeek).toBe("2026-W45");
    expect(result.rows).toHaveLength(4);
    expect(result.skippedKnownHistory).toBe(2);
  });

  it("separates DigiDirect barcode and part-label values from serial matching", () => {
    const base: ScanbackImport = {
      id: "fixture-import", kind: "claim", name: "digi-report.csv", state: "preview",
      createdAt: "2026-11-09T00:00:00.000Z", headers: [], sheets: ["CSV"], mapping: {},
      dateFormat: "dmy", sheet: "CSV", accountId: null, rows: [], errors: [], warnings: [],
      duplicate: false, recordCount: 0,
    };
    const raw = { CSV: [
      { Serial: "8801234567890", SKU: "MZ-TEST0000", SaleDate: "02/11/2026", Account: "digi" },
      { Serial: "LA69-02408A", SKU: "MZ-TEST0000", SaleDate: "03/11/2026", Account: "digi" },
      { Serial: "VALID-SERIAL-01", SKU: "MZ-TEST0000", SaleDate: "04/11/2026", Account: "digi" },
    ] };
    const imported = mapImport(base, raw as never, {
      mapping: { serial: "Serial", sku: "SKU", date: "SaleDate", account: "Account" },
      dateFormat: "dmy", sheet: "CSV", accountId: 1,
    }, [{ id: 1, code: "digi", name: "DigiDirect", aliases: [] }], new Set(["MZ-TEST0000"]));

    expect(imported.rows.map(row => row.rowIndex)).toEqual([0]);
    expect(imported.nonSerialCount).toBe(2);
    expect(imported.nonSerialIdentifiers).toEqual(["8801234567890", "LA69-02408A"]);
    expect(imported.errors).toEqual([]);
    expect(imported.warnings.some(warning => warning.includes("excluded from serial matching"))).toBe(true);
  });

  it("uses PLE SaleDay rather than an unrelated InvoiceDay", () => {
    const mapping = suggestMapping(["Serial", "SKU", "InvoiceDay", "SaleDay"]);
    expect(mapping.date).toBe("SaleDay");
  });
});
