import { describe, expect, it } from "vitest";
import {
  calendarDate, detectWeekFromFilename, isCompletedWeekAsOf, isWeekOutsideWindow,
  mostCommonWeek, previousCompletedWeekIso, resolveWeekFromFilename,
} from "./dates";

describe("central report dates", () => {
  it("recognizes a year/week filename with an intervening product token", () => {
    expect(detectWeekFromFilename("2026_SSD_WK_36_Sell-Out_Serialised.xlsx").weekIso).toBe("2026-W36");
  });

  it("uses the common in-file week instead of a conflicting filename week", () => {
    const filenameWeek = detectWeekFromFilename("weekly_2026_WK_42.csv").weekIso;
    const fileWeek = mostCommonWeek(["2026-11-02", "2026-11-03", "2026-11-04"]).weekIso;
    expect(filenameWeek).toBe("2026-W42");
    expect(fileWeek).toBe("2026-W45");
  });

  it("flags only report weeks outside the eight-week window", () => {
    expect(isWeekOutsideWindow("2026-W37", "2026-W46")).toBe(true);
    expect(isWeekOutsideWindow("2026-W38", "2026-W46")).toBe(false);
  });

  it("validates calendar dates used by specialized report formats", () => {
    expect(calendarDate(2028, 1, 29)).toBe("2028-02-29");
    expect(calendarDate(2027, 1, 29)).toBeNull();
  });

  it("moves a WK filename created Monday through Wednesday to the last completed week", () => {
    const resolved = resolveWeekFromFilename(
      "2026_WK_46_Samsung_SSD_SOH_reports_-_KS.xlsx",
      "2026-11-09T00:30:00.000Z",
      new Date("2026-11-09T00:30:00.000Z"),
    );
    expect(resolved.weekIso).toBe("2026-W45");
    expect(resolved.warning).toBe("Filename said WK 46 (not finished yet). Filed as w/e 8 Nov — check.");
  });

  it("keeps a named week when the file was created Friday within that week", () => {
    const resolved = resolveWeekFromFilename(
      "2026_WK_45_Samsung_SSD_SOH_reports_-_KS.xlsx",
      "2026-11-06",
      new Date("2026-11-09T00:30:00.000Z"),
    );
    expect(resolved.weekIso).toBe("2026-W45");
    expect(resolved.warning).toBeNull();
  });

  it("keeps a named week when the file was created Saturday within that week", () => {
    const resolved = resolveWeekFromFilename(
      "2026_WK_45_Samsung_SSD_SOH_reports_-_KS.xlsx",
      "2026-11-07",
      new Date("2026-11-09T00:30:00.000Z"),
    );
    expect(resolved.weekIso).toBe("2026-W45");
    expect(resolved.warning).toBeNull();
  });

  it("keeps and flags a named week that is unfinished when uploaded", () => {
    const resolved = resolveWeekFromFilename(
      "2026_WK_45_Samsung_SSD_SOH_reports_-_KS.xlsx",
      "2026-11-05",
      new Date("2026-11-06T00:00:00.000Z"),
    );
    expect(resolved.weekIso).toBe("2026-W45");
    expect(resolved.warning).toContain("week not finished yet");
  });

  it("keeps WK 42 when its file creation date is the week's ending Sunday", () => {
    const resolved = resolveWeekFromFilename(
      "2026_WK_42_Samsung_SSD_SOH_reports_-_KS.xlsx",
      "2026-10-18",
      new Date("2026-11-09T00:30:00.000Z"),
    );
    expect(resolved.weekIso).toBe("2026-W42");
    expect(resolved.warning).toBeNull();
  });

  it("clamps a filename date range ending tomorrow to the last Sydney-completed week", () => {
    const resolved = resolveWeekFromFilename(
      "report_2026-11-02_2026-11-10.xlsx",
      null,
      new Date("2026-11-09T00:30:00.000Z"),
    );
    expect(resolved.weekIso).toBe("2026-W45");
    expect(resolved.warning).toContain("Filed as w/e 8 Nov");
  });

  it("uses Australia/Sydney when selecting the last completed week", () => {
    const justPastMidnightSydney = new Date("2026-11-08T13:30:00.000Z");
    expect(previousCompletedWeekIso(justPastMidnightSydney)).toBe("2026-W45");
    expect(isCompletedWeekAsOf("2026-W46", justPastMidnightSydney)).toBe(false);
  });
});
