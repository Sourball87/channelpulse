export type WoiState = "value" | "no_sales" | "no_sales_data" | "no_soh";
export type WoiBand = "red" | "amber" | "neutral" | "blue" | "no_sales" | "missing";

export interface WoiObservation {
  sold: number | null;
  soldColumnPresent: boolean | null;
}

export interface WoiCalculation {
  avgWeeklySales: number | null;
  weeksObserved: number;
  windowWeeks: number;
  woi: number | null;
  state: WoiState;
}

/** Average only actual SOH/ST observations. Missing report weeks are not zero-sales weeks. */
export function calculateWoi(
  soh: number | null,
  observations: WoiObservation[],
  windowWeeks: number,
): WoiCalculation {
  const validWeeks = observations.filter(
    (observation): observation is { sold: number; soldColumnPresent: true } =>
      observation.soldColumnPresent === true &&
      typeof observation.sold === "number" &&
      Number.isFinite(observation.sold) &&
      observation.sold >= 0,
  );
  const weeksObserved = validWeeks.length;
  const totalSold = validWeeks.reduce((total, observation) => total + observation.sold, 0);
  const avgWeeklySales = weeksObserved > 0 ? totalSold / weeksObserved : null;

  if (soh == null) return { avgWeeklySales, weeksObserved, windowWeeks, woi: null, state: "no_soh" };
  if (avgWeeklySales == null) return { avgWeeklySales: null, weeksObserved, windowWeeks, woi: null, state: "no_sales_data" };
  if (avgWeeklySales === 0) return { avgWeeklySales: 0, weeksObserved, windowWeeks, woi: null, state: "no_sales" };
  return { avgWeeklySales, weeksObserved, windowWeeks, woi: soh / avgWeeklySales, state: "value" };
}

export function woiBand(woi: number | null, state: WoiState): WoiBand {
  if (state === "no_sales") return "no_sales";
  if (state !== "value" || woi == null || !Number.isFinite(woi)) return "missing";
  if (woi < 2) return "red";
  if (woi < 4) return "amber";
  if (woi <= 12) return "neutral";
  return "blue";
}
