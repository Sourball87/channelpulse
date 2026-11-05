import { describe, it, expect } from "vitest";
import { pool } from "@workspace/db";
import type { CenterUpload } from "@workspace/api-zod";

const base = process.env.UPLOAD_CENTER_INTEGRATION_URL;
describe.skipIf(!base)("Upload Center development API", () => {
  it("stages mixed files, persists corrections and references, and protects committed sources", async () => {
    if (base !== "http://localhost:80/api") throw new Error("Use the local development proxy only.");
    const prefix = `CENTERTEST${Date.now()}`;
    const ids = new Set<string>(), sources = new Set<string>(), sohIds = new Set<number>();
    let cookie = "";
    const call = async (path: string, method = "GET", body?: unknown) => {
      const response = await fetch(base + path, {
        method, headers: { Cookie: cookie, ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}) },
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, data: await response.json() as any };
    };
    const stage = async (files: [string, string][], accountId: number, week = "2026-W01") => {
      const form = new FormData();
      for (const [name, csv] of files) form.append("files", new Blob([csv]), `${prefix}-${name}.csv`);
      form.append("accountId", String(accountId)); form.append("weekIso", week); form.append("ai_assist", "false");
      const result = await call("/upload-center/files", "POST", form);
      expect(result.status).toBe(200);
      for (const e of result.data.uploads as CenterUpload[]) {
        ids.add(e.id);
        if (e.sourceId) (e.kind === "soh" ? sohIds.add(Number(e.sourceId)) : sources.add(e.sourceId));
      }
      return result.data;
    };
    try {
      expect((await call("/upload-center")).status).toBe(401);
      const login = await fetch(base + "/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: process.env.CHANNELPULSE_ADMIN_PASSWORD }),
      });
      expect(login.status).toBe(200);
      cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      const account = (await call("/resellers")).data.find((r: { active: boolean }) => r.active);
      const sku = `${prefix}-SKU`;
      const batch = await stage([
        ["soh", `SKU,SOH,Sold Last 7 Days\nMZ-77E1T0BW,12,3\n`],
        ["claim", `Customer,Model,Serial,Date\n${account.code},${sku},${prefix}A,01/01/2026\n`],
        ["evidence", `Account,SKU,Serial,Date,Invoice,Quantity,Unit Price\n${account.code},${sku},${prefix}A|${prefix}B,01/01/2026,${prefix}INV,2,100.00\n`],
        ["history", `Account,SKU,Serial,Date,Claim Amount,Promotion,Reference\n${account.code},${sku},${prefix}H,01/01/2026,10.00,${prefix}PROMO,${prefix}REF\n`],
        ["price", `SKU,Description,RRP Inc,DD Cost Ex,T1 Buy Ex\n${sku},Reference,110.01,65.27,90.99\n`],
        ["program", `SKU,GTM Buy Ex,${account.code}\n${sku},70.25,1\n`],
      ], account.id);
      expect(batch.errors).toEqual([]);
      expect(batch.uploads.map((e: CenterUpload) => e.kind).sort()).toEqual(["soh", "claim", "evidence", "history", "price", "program"].sort());
      expect(batch.uploads.every((e: CenterUpload) => e.state === "preview")).toBe(true);
      const find = (kind: string) => batch.uploads.find((e: CenterUpload) => e.kind === kind) as CenterUpload;
      const soh = find("soh");
      expect(soh.summary).toMatchObject({ soh: 12, unitsSold: 3, skuCount: 1 });
      const corrected = await call(`/upload-center/${soh.id}`, "PATCH", { weekIso: "2026-W02" });
      expect(corrected.status).toBe(200);
      expect(corrected.data.weekIso).toBe("2026-W02");
      const legacy = (await call("/uploads?limit=1000")).data.find((u: any) => String(u.id) === soh.sourceId);
      expect(legacy.week_iso).toBe("2026-W02");
      const evidence = find("evidence");
      expect(evidence.rowCount).toBe(1);
      expect(evidence.summary.serialCount).toBe(2);
      expect((await call(`/scanback/imports/${evidence.sourceId}/commit`, "POST", {})).status).toBe(200);
      expect((await call(`/upload-center/${evidence.id}`, "PATCH", { accountId: null })).status).toBe(409);
      expect((await call(`/upload-center/${evidence.id}`, "DELETE")).status).toBe(409);
      const claim = find("claim");
      expect((await call(`/scanback/imports/${claim.sourceId}/commit`, "POST", {})).status).toBe(200);
      const price = find("price"), program = find("program");
      expect((await call(`/upload-center/${price.id}/commit`, "POST", {})).status).toBe(200);
      expect((await call(`/upload-center/${program.id}/commit`, "POST", {})).status).toBe(200);
      const ws = (await call("/upload-center")).data;
      expect(ws.prices.find((p: any) => p.sku === sku)).toMatchObject({ rrpIncCents: 11001, ddCostExCents: 6527, t1BuyExCents: 9099 });
      expect(ws.programRows.find((p: any) => p.sku === sku)).toMatchObject({ gtmBuyCents: 7025 });
      expect(ws.uploads.find((p: CenterUpload) => p.id === claim.id).summary).toMatchObject({ ddRangeCount: 1, invoicedCount: 1, serialCount: 1 });
      expect((await call(`/upload-center/${price.id}`, "DELETE")).status).toBe(409);
      // Unsupported files remain pending; a user may explicitly reclassify.
      const unknown = await stage([["unknown", `Unrecognised,Value\nA,B\n`]], account.id);
      expect(unknown.uploads[0].kind).toBe("unknown");
      expect((await call(`/upload-center/${unknown.uploads[0].id}`, "PATCH", { kind: "program" })).status).toBe(200);
      expect((await call(`/upload-center/${unknown.uploads[0].id}/commit`, "POST", {})).status).toBe(400);
      expect((await call(`/upload-center/${unknown.uploads[0].id}`, "DELETE")).status).toBe(200);
      expect((await call(`/upload-center/${soh.id}`, "DELETE")).status).toBe(200);
    } finally {
      // Test-owned references/evidence only; never use broad business-data cleanup.
      await pool.query("DELETE FROM price_list WHERE upload_id=ANY($1::text[])", [[...ids]]);
      await pool.query("DELETE FROM center_uploads WHERE id=ANY($1::text[])", [[...ids]]);
      await pool.query("DELETE FROM scanback_imports WHERE id=ANY($1::text[])", [[...sources]]);
      await pool.query("DELETE FROM uploads WHERE id=ANY($1::int[])", [[...sohIds]]);
    }
  }, 60000);
});
