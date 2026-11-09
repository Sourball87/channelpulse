import { describe, expect, it } from "vitest";
import { calculateWoi, woiBand } from "./woi";

describe("WOI calculation", () => {
  it.each([4, 8, 13])("averages actual weekly sales across a %i-week window", (windowWeeks) => {
    const result = calculateWoi(60, [
      { sold: 10, soldColumnPresent: true },
      { sold: 20, soldColumnPresent: true },
      { sold: 30, soldColumnPresent: true },
      { sold: 20, soldColumnPresent: true },
      { sold: null, soldColumnPresent: false },
    ], windowWeeks);
    expect(result).toEqual({
      avgWeeklySales: 20,
      weeksObserved: 4,
      windowWeeks,
      woi: 3,
      state: "value",
    });
  });

  it("does not count missing sales reports as zero", () => {
    const result = calculateWoi(40, [
      { sold: 20, soldColumnPresent: true },
      { sold: null, soldColumnPresent: null },
      { sold: 0, soldColumnPresent: true },
      { sold: null, soldColumnPresent: false },
    ], 4);
    expect(result.avgWeeklySales).toBe(10);
    expect(result.weeksObserved).toBe(2);
    expect(result.woi).toBe(4);
  });

  it("keeps reported zero sales distinct from missing sales data", () => {
    expect(calculateWoi(25, [
      { sold: 0, soldColumnPresent: true },
      { sold: 0, soldColumnPresent: true },
    ], 4)).toMatchObject({ avgWeeklySales: 0, woi: null, state: "no_sales" });
    expect(calculateWoi(25, [
      { sold: null, soldColumnPresent: false },
    ], 4)).toMatchObject({ avgWeeklySales: null, woi: null, state: "no_sales_data" });
  });

  it("keeps missing SOH separate and applies the requested color boundaries", () => {
    expect(calculateWoi(null, [{ sold: 10, soldColumnPresent: true }], 4).state).toBe("no_soh");
    expect(woiBand(1.99, "value")).toBe("red");
    expect(woiBand(2, "value")).toBe("amber");
    expect(woiBand(3.99, "value")).toBe("amber");
    expect(woiBand(4, "value")).toBe("neutral");
    expect(woiBand(12, "value")).toBe("neutral");
    expect(woiBand(12.01, "value")).toBe("blue");
    expect(woiBand(null, "no_sales")).toBe("no_sales");
    expect(woiBand(null, "no_sales_data")).toBe("missing");
  });
});
