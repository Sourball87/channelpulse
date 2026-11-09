import { describe, it, expect } from "vitest";
import { pool } from "@workspace/db";
import type { CenterUpload } from "@workspace/api-zod";
import { weekBounds } from "./sales-reconciliation";

const base = process.env.SALES_RECONCILIATION_INTEGRATION_URL;
describe.skipIf(!base)("weekly serial reconciliation development API", () => {
  it("commits optional-sales SOH, reconciles serials, flags excess and updates the existing heatmap", async () => {
    if (base !== "http://localhost:80/api") throw new Error("Use the local development proxy only.");
    const prefix = `SALESTEST${Date.now()}`, sku = `${prefix}-SKU`, week = "2050-W10", date = weekBounds(week).start;
    const ids = new Set<string>(), sources = new Set<string>(), uploadIds = new Set<number>();
    let cookie = "", partId: number | undefined;
    const call = async (path: string, body?: unknown) => {
      const r = await fetch(base + path, { method: body === undefined ? "GET" : "POST",
        headers: { Cookie: cookie, ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}) },
        body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, data: await r.json() as any };
    };
    try {
      const login = await fetch(base + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: process.env.CHANNELPULSE_ADMIN_PASSWORD }) });
      expect(login.status).toBe(200);
      cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      const account = (await call("/resellers")).data[0];
      partId = (await pool.query("INSERT INTO parts(part_no,category) VALUES($1,'SSD') RETURNING id", [sku])).rows[0].id;
      const stage = async (name: string, csv: string): Promise<CenterUpload> => {
        const form = new FormData();
        form.append("files", new Blob([csv]), `${prefix}-${name}.csv`);
        form.append("accountId", String(account.id)); form.append("weekIso", week); form.append("ai_assist", "false");
        const r = await call("/upload-center/files", form);
        expect(r.status).toBe(200); expect(r.data.errors).toEqual([]);
        const entry = r.data.uploads[0] as CenterUpload;
        ids.add(entry.id);
        if (entry.sourceId) (entry.kind === "soh" ? uploadIds.add(Number(entry.sourceId)) : sources.add(entry.sourceId));
        return entry;
      };
      const commitSoh = async (entry: CenterUpload, sold: boolean, overwrite = false) => {
        if (entry.state === "committed") return;
        const mappings = [
          { source_col: "SKU", canonical_field: "part_no", confidence: 1 },
          { source_col: "SOH", canonical_field: "soh", confidence: 1 },
          ...(sold ? [{ source_col: "Sold Last 7 Days", canonical_field: "sell_through_7d", confidence: 1 }] : []),
        ];
        const r = await call(`/upload-center/${entry.id}/commit`,
          { reseller_id: account.id, week_iso: week, mappings, confirm_overwrite: overwrite });
        expect(r.status, JSON.stringify(r.data)).toBe(200);
      };
      const soh = await stage("soh", `SKU,SOH,Sold Last 7 Days\n${sku},20,2\n`);
      await commitSoh(soh, true);
      const path = `/dashboard/serial-reconciliation?week_iso=${week}&part_ids=${partId}&reseller_ids=${account.id}`;
      const current = async () => (await call(path)).data.rows.find((r: any) => r.week_iso === week);
      expect(await current()).toMatchObject({ soh: 20, soh_sold: 2, serials_reported: null, serial_match_pct: null, serial_report_received: false });
      const dd = await stage("evidence", "Invoice,Invoice Date,Account,SKU,Quantity,Serial,Unit Price\n" +
        ["A", "B", "C"].map(s => `${prefix}INV${s},${date},${account.code},${sku},1,${prefix}${s},100.00\n`).join(""));
      expect((await call(`/scanback/imports/${dd.sourceId}/commit`, {})).status).toBe(200);
      const report = await stage("claim", "Serial,SKU,Sale Date,Account\n" +
        ["A", "B", "C"].map(s => `${prefix}${s},${sku},${date},${account.code}\n`).join(""));
      expect((await call(`/scanback/imports/${report.sourceId}/commit`, {})).status).toBe(200);
      expect(await current()).toMatchObject({ serials_reported: 3, serial_match_pct: 150, dd_sell_in_week: 3, sell_through: 2 });
      expect((await current()).alerts).toEqual([{ severity: "high", message: "More serials than sold — check before paying claims" }]);
      const alerts = await call(`/alerts?week_iso=${week}&part_ids=${partId}&reseller_ids=${account.id}&type=serials_exceed_sold`);
      expect(alerts.data.some((a: any) => a.type === "serials_exceed_sold" && a.severity === "critical")).toBe(true);
      const fallback = await stage("soh-no-sold", `SKU,SOH\n${sku},20\n`);
      await commitSoh(fallback, false, true);
      expect(await current()).toMatchObject({ soh_sold: null, sold_column_present: false, sell_through: 3, sell_through_source: "serials", serial_match_pct: null, alerts: [] });
      const heatmap = await call(`/dashboard/weekly-sales?week_iso=${week}&part_ids=${partId}&reseller_ids=${account.id}`);
      expect(heatmap.data.cells.find((r: any) => r.week_iso === week)).toMatchObject({ units_sold: 3, serials_backed: true, serials_reported: 3 });
      const future = await call(path.replace(week, "2050-W11"));
      expect(future.data.pronto_note).toContain("before the selected week");
      expect(future.data.rows.find((r: any) => r.week_iso === "2050-W11")).toMatchObject({ dd_sell_in_week: null, serials_reported: null, sell_through: null });
      expect((await call(path + "&category=Monitor")).data.rows).toEqual([]);
    } finally {
      await pool.query("DELETE FROM center_uploads WHERE id=ANY($1::text[])", [[...ids]]);
      await pool.query("DELETE FROM scanback_imports WHERE id=ANY($1::text[])", [[...sources]]);
      await pool.query("DELETE FROM uploads WHERE id=ANY($1::int[])", [[...uploadIds]]);
      if (partId != null) await pool.query("DELETE FROM parts WHERE id=$1", [partId]);
    }
  }, 90_000);
});
