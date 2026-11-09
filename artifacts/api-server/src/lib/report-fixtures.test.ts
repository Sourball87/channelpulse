import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectCenterKind, readCenterCsv, readCenterSheets } from "./center-parser";
import { detectWeekFromFilename, isValidWeekIso, mostCommonWeek } from "./dates";
import { parseSheets, parseCsvSheets, detectImportKind } from "./scanback-import";
import { parseFile } from "./file-parser";
import type { ResellerProfile } from "./parser";

const assetsDir = fileURLToPath(new URL("../../../../attached_assets/", import.meta.url));
const fixtures = readdirSync(assetsDir)
  .filter(name => name.includes("179420") && /\.(csv|xlsx)$/i.test(name))
  .sort();
const profiles: ResellerProfile[] = [
  ["ca", "Computer Alliance"], ["centrecom", "Centrecom"], ["scorptec", "Scorptec"],
  ["ple", "PLE Computers"], ["pccg", "PCCG"], ["umart", "Umart"],
  ["ks", "KS Computer Tech"], ["jw", "JW Computers"], ["digi", "DigiDirect"],
].map(([code, name], index) => ({
  id: index + 1, code, name, aliases: [], filenamePatterns: [],
}));

describe("attached reseller report fixtures", () => {
  it("covers all 17 report files without including the task-note attachments", () => {
    expect(fixtures).toHaveLength(17);
  });

  it.each(fixtures)("%s parses and identifies its report type", async filename => {
    const buffer = readFileSync(join(assetsDir, filename));
    const sheets = filename.toLowerCase().endsWith(".csv")
      ? await readCenterCsv(buffer)
      : readCenterSheets(buffer);
    const sheetsWithRows = Object.entries(sheets).filter(([, rows]) => rows.length > 0);
    expect(sheetsWithRows.length).toBeGreaterThan(0);

    const kinds = sheetsWithRows.map(([sheetName, rows]) =>
      detectCenterKind(Object.keys(rows[0]), sheetName, filename));
    const expectedKind = /soh|_report_|hdd_weekly/i.test(filename) ? "soh" : "claim";
    expect(kinds).toContain(expectedKind);

    if (expectedKind === "soh") {
      const parsed = await parseFile(buffer, filename, profiles);
      const mappedFields = parsed.mappings.map(mapping => mapping.canonical_field);
      expect(mappedFields).toContain("part_no");
      expect(mappedFields).toContain("soh");
    } else {
      const serialSheets = filename.toLowerCase().endsWith(".csv")
        ? await parseCsvSheets(buffer)
        : parseSheets(buffer);
      const serialRows = Object.values(serialSheets).find(rows => rows.length > 0) ?? [];
      expect(detectImportKind(Object.keys(serialRows[0] ?? {}))).toBe("claim");
    }

    const detected = detectWeekFromFilename(filename);
    if (detected.weekIso) {
      expect(isValidWeekIso(detected.weekIso)).toBe(true);
    } else {
      const dates = sheetsWithRows.flatMap(([, rows]) => {
        const headings = Object.keys(rows[0]).filter(heading => /date|day|sold|sale/i.test(heading));
        return rows.flatMap(row => headings.map(heading => row[heading]));
      });
      const fromContent = [mostCommonWeek(dates, "dmy"), mostCommonWeek(dates, "mdy")]
        .map(result => result.weekIso).find(Boolean);
      expect(fromContent).toBeTruthy();
      expect(isValidWeekIso(fromContent!)).toBe(true);
      if (filename.includes("Samsung_SSD_Weekly_Sales_with_Serial_Number"))
        expect(fromContent).toBe("2026-W43");
    }
  });
});
