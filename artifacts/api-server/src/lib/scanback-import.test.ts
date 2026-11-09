import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import type { ScanbackImport } from "@workspace/api-zod";
import { dateStringToWeekIso, detectWeekFromFilename, parseDateValue } from "./dates";
import { filterFullHistorySerialRows, mapImport, parseCsvSheets, suggestMapping } from "./scanback-import";

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
    expect(result.historicalRowsSkipped).toBe(2);
    expect(result.isFullHistory).toBe(false);
  });

  it("keeps only the filename week from the real 184,172-row PLE full-history file", async () => {
    const filename = "Samsung-SSD-Serial_2026-10-05_2026-10-11_PLE.csv";
    const buffer = await readFile(new URL(
      "../../../../attached_assets/Samsung-SSD-Serial_2026-10-05_2026-10-11_PLE_1794204905280.csv",
      import.meta.url,
    ));
    const parsed = await parseCsvSheets(buffer);
    const rows = parsed.CSV;
    const headers = Object.keys(rows[0]).filter(header => header !== "__sourceRow");
    const mapping = suggestMapping(headers);
    const result = filterFullHistorySerialRows(rows, mapping, [], detectWeekFromFilename(filename).weekIso);

    expect(rows).toHaveLength(184_172);
    expect(result.isFullHistory).toBe(true);
    expect(result.weekIso).toBe("2026-W41");
    expect(result.rows).toHaveLength(50);
    expect(result.historicalRowsSkipped).toBe(184_122);
    expect(result.rows.every(row => {
      const date = parseDateValue(row.SaleDay);
      return date >= "2026-10-05" && date <= "2026-10-11" &&
        dateStringToWeekIso(date) === "2026-W41";
    })).toBe(true);
  });

  it("filters a small non-PLE multi-month report by its filename week", () => {
    const rows = Array.from({ length: 500 }, (_, index) => ({
      SerialNumber: `OTHER-${index}`,
      SaleDay: new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10),
    }));
    const filenameWeek = detectWeekFromFilename("customer_report_2026-10-05_2026-10-11.csv").weekIso;
    const result = filterFullHistorySerialRows(rows, { serial: "SerialNumber", date: "SaleDay" }, [], filenameWeek);

    expect(result.isFullHistory).toBe(true);
    expect(result.weekIso).toBe("2026-W41");
    expect(result.rows).toHaveLength(7);
    expect(result.historicalRowsSkipped).toBe(493);
    expect(result.rows.every(row => dateStringToWeekIso(parseDateValue(row.SaleDay)) === "2026-W41")).toBe(true);
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

  it("maps SKU from the PLE serial-report ModelCode header", () => {
    const headers = ["SaleDay", "ChannelCode", "PromoterID", "ModelCode", "Sales", "SerialNumber", "InvoiceDay"];
    const mapping = suggestMapping(headers);
    expect(mapping).toMatchObject({ date: "SaleDay", sku: "ModelCode", serial: "SerialNumber" });
    expect(suggestMapping(["ManufacturerModel"]).sku).toBe("ManufacturerModel");

    const base: ScanbackImport = {
      id: "ple-claim", kind: "claim", name: "weekly_serials.csv", state: "preview",
      createdAt: "2026-11-09T00:00:00.000Z", headers, sheets: ["CSV"], mapping: {},
      dateFormat: "dmy", sheet: "CSV", accountId: 7, rows: [], errors: [], warnings: [],
      duplicate: false, recordCount: 0,
    };
    const imported = mapImport(base, { CSV: [{
      SaleDay: "05/10/2026", ChannelCode: "A", PromoterID: "P", ModelCode: "MZ-PLE-SSD",
      Sales: 1, SerialNumber: "SERIAL-01", InvoiceDay: "06/10/2026",
    }] }, { mapping, dateFormat: "dmy", sheet: "CSV", accountId: 7 },
    [{ id: 7, code: "ple", name: "PLE Computers" }], new Set());
    expect(imported.rows[0]).toMatchObject({ serial: "SERIAL-01", sku: "MZ-PLE-SSD", date: "2026-10-05" });
  });
});
