import { describe, expect, it } from "vitest";
import {
  calendarDate, detectWeekFromFilename, isWeekOutsideWindow, mostCommonWeek,
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
});
