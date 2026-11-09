import { describe, expect, it } from "vitest";

const base = process.env.SCANBACK_INTEGRATION_URL;

describe.skipIf(!base)("Dashboard and Explorer HTTP analytics", () => {
  it("serves WOI data, Explorer measures, shared part order and Excel export", async () => {
    if (base !== "http://localhost:80/api") {
      throw new Error("Integration test must use the local development proxy.");
    }
    const login = await fetch(base + "/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "admin",
        password: process.env.CHANNELPULSE_ADMIN_PASSWORD,
      }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(cookie).toContain("channelpulse_session=");
    const headers = { Cookie: cookie };

    const availableWeeks = await fetch(base + "/dashboard/weeks", { headers });
    expect(availableWeeks.status).toBe(200);
    const weekRows = await availableWeeks.json() as { week_iso: string }[];
    const latestWeek = weekRows[0]?.week_iso;
    const weekParam = latestWeek ? `&week_iso=${encodeURIComponent(latestWeek)}` : "";

    const woiResponse = await fetch(base + `/dashboard/woi-heatmap?weeks=4${weekParam}`, { headers });
    expect(woiResponse.status).toBe(200);
    const woi = await woiResponse.json() as { week_iso: string | null; window_weeks: number; rows: unknown[] };
    expect(woi.window_weeks).toBe(4);
    if (latestWeek) expect(woi.week_iso).toBe(latestWeek);
    expect(Array.isArray(woi.rows)).toBe(true);

    const explorerResponse = await fetch(base + `/explorer/analytics?woi_weeks=4${weekParam}`, { headers });
    expect(explorerResponse.status).toBe(200);
    const explorer = await explorerResponse.json() as {
      week_iso: string | null;
      rows: { sold: number | null; soh: number | null; woi: number | null; serials_reported: number | null; dd_sell_in: number | null }[];
    };
    if (latestWeek) expect(explorer.week_iso).toBe(latestWeek);
    expect(Array.isArray(explorer.rows)).toBe(true);

    const partsResponse = await fetch(base + "/parts", { headers });
    expect(partsResponse.status).toBe(200);
    const parts = await partsResponse.json() as { id: number; sort_order: number }[];
    expect(parts.every(part => Number.isInteger(part.sort_order))).toBe(true);

    const exportResponse = await fetch(base + "/explorer/export", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ columns: ["SKU", "WOI"], rows: [["Example", 4]] }),
    });
    expect(exportResponse.status).toBe(200);
    expect(exportResponse.headers.get("content-type")).toContain("spreadsheetml.sheet");
    const bytes = new Uint8Array(await exportResponse.arrayBuffer());
    expect(String.fromCharCode(bytes[0], bytes[1])).toBe("PK");
  });
});
