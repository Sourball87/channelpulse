import { describe, it, expect } from "vitest";
import { pool } from "@workspace/db";
import type { CenterUpload } from "@workspace/api-zod";

const base = process.env.PROGRAM_TABLE_INTEGRATION_URL;
const csvRow = (row: unknown[]) => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(",");
describe.skipIf(!base)("Upload Center program-table preview", () => {
  it("previews dates, duplicate SKU, ignored calculations and caps through the real upload route", async () => {
    if (base !== "http://localhost:80/api") throw new Error("Use the local development proxy only.");
    const accounts = (await pool.query("SELECT id,code FROM resellers ORDER BY id LIMIT 1")).rows as {id:number;code:string}[];
    expect(accounts).toHaveLength(1);
    const account = accounts[0], prefix = `PROGRAMREVIEW${Date.now()}`;
    const uploadIds = new Set<string>();
    let cookie = "";
    const call = async (path: string, body?: unknown) => {
      const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST",
        headers: { Cookie: cookie, ...(body && !(body instanceof FormData) ? { "Content-Type":"application/json" } : {}) },
        body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, data: await response.json() as any };
    };
    try {
      const login = await fetch(base + "/auth/login", { method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ username:"admin", password:process.env.CHANNELPULSE_ADMIN_PASSWORD }) });
      expect(login.status).toBe(200); cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      const headers = ["SKU","RRP Inc","GTM Inc","Discount","DD Std Cost Ex","T1 EX","GTM Buy Ex","STA Qty","STA Cost","REV TOTAL","Part No.","",account.code,"Total"];
      const values = [`${prefix}-SKU`, "$449", "$269", "-40%", "$307", "$323", "$232", "$9", "$81,462", "$276,017", `${prefix}-SKU`, "", "7", "7"];
      const totals = Array(headers.length).fill(""); totals[12] = "7"; totals[13] = "7";
      const csv = [
        ["Start", "28-Sep"], ["End", "31-Oct", "", "", "Allocation"], ["Allocation"], headers,
        Array(headers.length).fill(""), values, totals, Array(headers.length).fill(""),
      ].map(csvRow).join("\n");
      const form = new FormData(); form.append("files", new Blob([csv]), `${prefix}.csv`);
      form.append("accountId", String(account.id)); form.append("weekIso", "2026-W40"); form.append("ai_assist", "false");
      const staged = await call("/upload-center/files", form);
      expect(staged.status, JSON.stringify(staged.data)).toBe(200);
      const upload = (staged.data.uploads as CenterUpload[]).find(u => u.name === `${prefix}.csv`)!;
      expect(upload).toMatchObject({ kind:"program", state:"preview", programSource:{startDate:expect.stringMatching(/-09-28$/),endDate:expect.stringMatching(/-10-31$/)} });
      expect(upload.programSource?.ignoredRows).toEqual(expect.arrayContaining([
        { row: 5, reason: "Blank row." }, { row: 7, reason: "Numeric totals row." },
      ]));
      uploadIds.add(upload.id);
      const preview = await call("/scanback/programs/preview", { uploadId: upload.id, ai_assist:false });
      expect(preview.status, JSON.stringify(preview.data)).toBe(200);
      expect(preview.data.ignoredRows).toEqual(expect.arrayContaining([
        { row: 5, reason: "Blank row." }, { row: 7, reason: "Numeric totals row." },
      ]));
      expect(preview.data.rows[0]).toMatchObject({ sku: values[0], rrpIncCents:44900, gtmIncCents:26900, ddCostExCents:30700, t1ExCents:32300, gtmBuyCents:23200 });
      expect(preview.data.rows[0].caps).toEqual([{resellerId:account.id,quantity:7}]);
      expect(preview.data.mapping.ignored).toEqual(expect.arrayContaining(["Discount","STA Qty","STA Cost","REV TOTAL","Part No.","Total"]));
      expect(preview.data.issues.filter((i:any)=>i.blocking)).toEqual([]);
    } finally {
      await pool.query("DELETE FROM center_uploads WHERE id=ANY($1::text[])", [[...uploadIds]]);
    }
  }, 60_000);
});
