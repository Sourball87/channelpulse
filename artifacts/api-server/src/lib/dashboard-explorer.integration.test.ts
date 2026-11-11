import { describe, expect, it } from "vitest";
import { pool } from "@workspace/db";

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

  it("applies single-week and period filters to SOH and per-customer WOI", async () => {
    if (base !== "http://localhost:80/api") {
      throw new Error("Integration test must use the local development proxy.");
    }
    const prefix = `DASHRANGE${Date.now()}`;
    const resellerIds: number[] = [];
    const uploadIds: number[] = [];
    const partIds: number[] = [];
    let cookie = "";
    try {
      const login = await fetch(base + "/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: process.env.CHANNELPULSE_ADMIN_PASSWORD }),
      });
      expect(login.status).toBe(200);
      cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      const headers = { Cookie: cookie };

      const first = await pool.query(
        "INSERT INTO resellers(name,code,active) VALUES($1,$2,true) RETURNING id",
        [`${prefix} First`, `${prefix}A`],
      );
      const second = await pool.query(
        "INSERT INTO resellers(name,code,active) VALUES($1,$2,true) RETURNING id",
        [`${prefix} Second`, `${prefix}B`],
      );
      resellerIds.push(Number(first.rows[0].id), Number(second.rows[0].id));
      const part = await pool.query(
        "INSERT INTO parts(part_no,category,active) VALUES($1,'Dashboard test',true) RETURNING id",
        [`${prefix}-SKU`],
      );
      partIds.push(Number(part.rows[0].id));

      const mappings = JSON.stringify([
        { canonical_field: "part_no", source_col: "SKU" },
        { canonical_field: "soh", source_col: "SOH" },
        { canonical_field: "sell_through_7d", source_col: "Sold" },
      ]);
      const addSnapshot = async (resellerId: number, week: string, soh: number, sold: number) => {
        const uploaded = await pool.query(`INSERT INTO uploads
          (reseller_id,filename,file_hash,week_iso,status,detected_mappings)
          VALUES($1,$2,$3,$4,'committed',$5::jsonb) RETURNING id`, [
          resellerId, `${prefix}-${week}.csv`, `${prefix}-${resellerId}-${week}`, week, mappings,
        ]);
        const uploadId = Number(uploaded.rows[0].id);
        uploadIds.push(uploadId);
        await pool.query(`INSERT INTO inventory_snapshots
          (upload_id,reseller_id,part_id,week_iso,soh,sell_through_7d)
          VALUES($1,$2,$3,$4,$5,$6)`,
        [uploadId, resellerId, partIds[0], week, soh, sold]);
      };

      const [firstId, secondId] = resellerIds;
      await addSnapshot(firstId, "2026-W30", 100, 20);
      await addSnapshot(firstId, "2026-W31", 80, 20);
      await addSnapshot(firstId, "2026-W32", 60, 20);
      await addSnapshot(secondId, "2026-W30", 50, 10);
      await addSnapshot(secondId, "2026-W31", 40, 0);

      const params = `part_ids=${partIds[0]}&reseller_ids=${resellerIds.join(",")}`;
      const singleResponse = await fetch(base + `/dashboard/heatmap?week_iso=2026-W30&${params}`, { headers });
      expect(singleResponse.status).toBe(200);
      const single = await singleResponse.json() as { cells: { reseller_id: number; soh: number; st: number; as_at_week: string }[] };
      expect(single.cells.find(cell => cell.reseller_id === firstId)).toMatchObject({ soh: 100, st: 20, as_at_week: "2026-W30" });
      expect(single.cells.find(cell => cell.reseller_id === secondId)).toMatchObject({ soh: 50, st: 10, as_at_week: "2026-W30" });

      const singleWoiResponse = await fetch(base + `/dashboard/woi-heatmap?week_iso=2026-W30&weeks=4&${params}`, { headers });
      expect(singleWoiResponse.status).toBe(200);
      const singleWoi = await singleWoiResponse.json() as {
        rows: { part_id: number; cells: { reseller_id: number | null; soh: number | null; sales_total: number | null; as_at_week: string | null }[] }[];
      };
      const singleWoiCells = singleWoi.rows.find(row => row.part_id === partIds[0])!.cells;
      expect(singleWoiCells.find(cell => cell.reseller_id === firstId)).toMatchObject({
        soh: 100, sales_total: 20, as_at_week: "2026-W30",
      });
      expect(singleWoiCells.find(cell => cell.reseller_id === secondId)).toMatchObject({
        soh: 50, sales_total: 10, as_at_week: "2026-W30",
      });

      const rangeHeatmapResponse = await fetch(base + `/dashboard/heatmap?week_from=2026-W30&week_to=2026-W32&${params}`, { headers });
      expect(rangeHeatmapResponse.status).toBe(200);
      const rangeHeatmap = await rangeHeatmapResponse.json() as {
        weeks_in_range: number;
        cells: { reseller_id: number; soh: number; st: number; as_at_week: string }[];
      };
      expect(rangeHeatmap.weeks_in_range).toBe(3);
      expect(rangeHeatmap.cells.find(cell => cell.reseller_id === firstId)).toMatchObject({ soh: 60, st: 60, as_at_week: "2026-W32" });
      expect(rangeHeatmap.cells.find(cell => cell.reseller_id === secondId)).toMatchObject({ soh: 40, st: 10, as_at_week: "2026-W31" });

      const rangeWoiResponse = await fetch(base + `/dashboard/woi-heatmap?week_from=2026-W30&week_to=2026-W32&weeks=4&${params}`, { headers });
      expect(rangeWoiResponse.status).toBe(200);
      const rangeWoi = await rangeWoiResponse.json() as {
        window_weeks: number;
        rows: { part_id: number; cells: {
          reseller_id: number | null; soh: number | null; sales_total: number | null;
          avg_weekly_sales: number | null; weeks_observed: number; woi: number | null; as_at_week: string | null;
        }[] }[];
      };
      expect(rangeWoi.window_weeks).toBe(3);
      const woiCells = rangeWoi.rows.find(row => row.part_id === partIds[0])!.cells;
      expect(woiCells.find(cell => cell.reseller_id === firstId)).toMatchObject({
        soh: 60, sales_total: 60, avg_weekly_sales: 20, weeks_observed: 3, woi: 3, as_at_week: "2026-W32",
      });
      expect(woiCells.find(cell => cell.reseller_id === secondId)).toMatchObject({
        soh: 40, sales_total: 10, avg_weekly_sales: 5, weeks_observed: 2, woi: 8, as_at_week: "2026-W31",
      });
    } finally {
      await pool.query("DELETE FROM inventory_snapshots WHERE upload_id=ANY($1::int[])", [uploadIds]);
      await pool.query("DELETE FROM uploads WHERE id=ANY($1::int[])", [uploadIds]);
      await pool.query("DELETE FROM parts WHERE id=ANY($1::int[])", [partIds]);
      await pool.query("DELETE FROM resellers WHERE id=ANY($1::int[])", [resellerIds]);
    }
  }, 60000);

  it("filters Explorer analytics by category and restores all categories when cleared", async () => {
    if (base !== "http://localhost:80/api") {
      throw new Error("Integration test must use the local development proxy.");
    }
    const prefix = `EXPCATEGORY${Date.now()}`;
    const resellerIds: number[] = [];
    const partIds: number[] = [];
    const uploadIds: number[] = [];
    let cookie = "";
    try {
      const login = await fetch(base + "/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: process.env.CHANNELPULSE_ADMIN_PASSWORD }),
      });
      expect(login.status).toBe(200);
      cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      const headers = { Cookie: cookie };

      const reseller = await pool.query(
        "INSERT INTO resellers(name,code,active) VALUES($1,$2,true) RETURNING id",
        [`${prefix} Reseller`, `${prefix}R`],
      );
      resellerIds.push(Number(reseller.rows[0].id));
      const firstPart = await pool.query(
        "INSERT INTO parts(part_no,category,active) VALUES($1,$2,true) RETURNING id",
        [`${prefix}-SSD`, `${prefix} SSD`],
      );
      const secondPart = await pool.query(
        "INSERT INTO parts(part_no,category,active) VALUES($1,$2,true) RETURNING id",
        [`${prefix}-Monitor`, `${prefix} Monitor`],
      );
      partIds.push(Number(firstPart.rows[0].id), Number(secondPart.rows[0].id));

      const mappings = JSON.stringify([
        { canonical_field: "part_no", source_col: "SKU" },
        { canonical_field: "soh", source_col: "SOH" },
        { canonical_field: "sell_through_7d", source_col: "Sold" },
      ]);
      const upload = await pool.query(`INSERT INTO uploads
        (reseller_id,filename,file_hash,week_iso,status,detected_mappings)
        VALUES($1,$2,$3,'2026-W32','committed',$4::jsonb) RETURNING id`,
      [resellerIds[0], `${prefix}.csv`, prefix, mappings]);
      uploadIds.push(Number(upload.rows[0].id));
      await pool.query(`INSERT INTO inventory_snapshots
        (upload_id,reseller_id,part_id,week_iso,soh,sell_through_7d)
        VALUES($1,$2,$3,'2026-W32',100,10),($1,$2,$4,'2026-W32',50,5)`,
      [uploadIds[0], resellerIds[0], partIds[0], partIds[1]]);

      const scopedParams = `week_iso=2026-W32&woi_weeks=4&part_ids=${partIds.join(",")}&reseller_ids=${resellerIds[0]}`;
      const allResponse = await fetch(base + `/explorer/analytics?${scopedParams}`, { headers });
      expect(allResponse.status).toBe(200);
      const allData = await allResponse.json() as { rows: { part_id: number }[] };
      expect(new Set(allData.rows.map((row) => row.part_id))).toEqual(new Set(partIds));

      const selectedResponse = await fetch(
        base + `/explorer/analytics?${scopedParams}&category=${encodeURIComponent(`${prefix} SSD`)}`,
        { headers },
      );
      expect(selectedResponse.status).toBe(200);
      const selectedData = await selectedResponse.json() as { rows: { part_id: number }[] };
      expect(selectedData.rows.map((row) => row.part_id)).toEqual([partIds[0]]);
    } finally {
      await pool.query("DELETE FROM inventory_snapshots WHERE upload_id=ANY($1::int[])", [uploadIds]);
      await pool.query("DELETE FROM uploads WHERE id=ANY($1::int[])", [uploadIds]);
      await pool.query("DELETE FROM parts WHERE id=ANY($1::int[])", [partIds]);
      await pool.query("DELETE FROM resellers WHERE id=ANY($1::int[])", [resellerIds]);
    }
  }, 60000);
});
