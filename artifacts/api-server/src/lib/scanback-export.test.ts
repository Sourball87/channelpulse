import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import type { ScanbackExportData } from "./scanback-export";
import { makeScanbackWorkbook } from "./scanback-export";
import { expiredWeeklyExports, weeklyExportName } from "./scanback-export-storage";

describe("scanback exports", () => {
  it("writes all requested data groups into a single workbook", () => {
    const data: ScanbackExportData = {
      programs: [{
        id: "program-1", name: "Spring", version: 1, start: "2026-09-01", end: "2026-09-30",
        archived: false, notes: "", createdAt: "", customerIds: [1],
        lines: [{ partId: null, sku: "SKU-1", gtmBuyCents: 7000, caps: [{ resellerId: 1, quantity: 4 }] }],
      }],
      batches: [{
        id: "batch-1", reference: "REF-1", programName: "Spring", accountCode: "ca", createdAt: "2026-09-30T00:00:00Z",
        totalCents: 3000, approvedCount: 1, historical: false, basis: "invoice", from: "2026-09-01", to: "2026-09-30", rows: [],
      }],
      approvedSerials: [{
        serial: "SERIAL1", batchId: "batch-1", reference: "REF-1", programName: "Spring",
        accountCode: "ca", sku: "SKU-1", amountCents: 3000,
      }],
      creditResolutions: [[
        "credit.xlsx", 12, "CA", "SKU-1", "CR-1", "2026-09-04", -1, "reviewed",
        "", "Checked return.", "2026-09-05T00:00:00Z", "admin",
      ]],
      resellers: [{ id: 1, code: "ca", name: "Computer Alliance", active: true, expectedWeeklyFiles: 2 }],
    };
    const workbook = XLSX.read(makeScanbackWorkbook(data), { type: "buffer" });
    expect(workbook.SheetNames).toEqual([
      "Programs", "Approved batches", "Approved serials", "Credit resolutions", "Resellers",
    ]);
    expect(XLSX.utils.sheet_to_json(workbook.Sheets["Approved serials"], { header: 1 })).toContainEqual([
      "SERIAL1", "REF-1", "Spring", "CA", "SKU-1", 3000,
    ]);
    expect(XLSX.utils.sheet_to_json(workbook.Sheets["Credit resolutions"], { header: 1 })).toContainEqual([
      "credit.xlsx", 12, "CA", "SKU-1", "CR-1", "2026-09-04", -1,
      "reviewed", "", "Checked return.", "2026-09-05T00:00:00Z", "admin",
    ]);
    expect(XLSX.utils.sheet_to_json(workbook.Sheets.Resellers, { header: 1 })).toContainEqual([
      "CA", "CA", true, 2,
    ]);
  });

  it("uses Australian ISO week names and retains only the newest 12 backups", () => {
    expect(weeklyExportName(new Date("2026-01-01T00:00:00Z"))).toBe("scanback-weekly-2026-W01.xlsx");
    const files = Array.from({ length: 14 }, (_, index) => ({
      name: `scanback-weekly-2026-W${String(index + 1).padStart(2, "0")}.xlsx`,
      createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      size: 100,
    }));
    expect(expiredWeeklyExports(files)).toHaveLength(2);
    expect(expiredWeeklyExports(files).map(file => file.name)).toEqual([
      "scanback-weekly-2026-W02.xlsx", "scanback-weekly-2026-W01.xlsx",
    ]);
  });
});
