import { describe, expect, it } from "vitest";
import { displayDate, displayDateTime } from "./date-display";

describe("uniform display dates", () => {
  it("uses padded days, three-letter months and four-digit years", () => {
    expect(displayDate("2026-11-08")).toBe("08 Nov 2026");
    expect(displayDate("2026-09-01")).toBe("01 Sep 2026");
    expect(displayDate("2024-02-29")).toBe("29 Feb 2024");
  });
  it("does not shift calendar dates or silently repair invalid dates", () => {
    expect(displayDate("2026-01-01")).toBe("01 Jan 2026");
    expect(displayDate("2026-02-29")).toBe("2026-02-29");
    expect(displayDate("not a date")).toBe("not a date");
    expect(displayDate(null)).toBe("");
  });
  it("shows timestamps in Sydney across daylight saving and UTC date boundaries", () => {
    expect(displayDate("2026-11-07T14:00:00Z")).toBe("08 Nov 2026");
    expect(displayDateTime("2026-11-07T14:00:00Z")).toBe("08 Nov 2026, 01:00 am Sydney");
    expect(displayDateTime("2026-07-01T00:00:00Z")).toBe("01 Jul 2026, 10:00 am Sydney");
    expect(displayDateTime("")).toBe("");
  });
});
