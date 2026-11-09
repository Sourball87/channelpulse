import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { pool } from "@workspace/db";
import type { CenterUpload } from "@workspace/api-zod";
import { computeHeaderFingerprint } from "./parser";
import { currentWeekIso } from "./dates";

const base = process.env.UPLOAD_CENTER_INTEGRATION_URL;
describe.skipIf(!base)("Upload Center development API", () => {
  it("stages mixed files, persists corrections and references, and protects committed sources", async () => {
    if (base !== "http://localhost:80/api") throw new Error("Use the local development proxy only.");
    const prefix = `CENTERTEST${Date.now()}`;
    const ids = new Set<string>(), sources = new Set<string>(), sohIds = new Set<number>();
    const testSkus = new Set<string>();
    let accountId: number | null = null;
    let originalAliases: string[] = [];
    let originalFilenamePatterns: string[] = [];
    let fingerprintWasPresent = false;
    let fingerprintChecked = false;
    const sohFingerprint = computeHeaderFingerprint(["SKU", "SOH", "Sold Last 7 Days"]);
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
      accountId = account.id;
      originalAliases = [...(account.aliases ?? [])];
      const originalReseller = (await pool.query(
        "SELECT aliases,filename_patterns FROM resellers WHERE id=$1", [account.id],
      )).rows[0];
      originalAliases = [...(originalReseller.aliases ?? [])];
      originalFilenamePatterns = [...(originalReseller.filename_patterns ?? [])];
      fingerprintWasPresent = ((await pool.query(
        "SELECT 1 FROM reseller_format_associations WHERE reseller_id=$1 AND fingerprint=$2",
        [account.id, sohFingerprint],
      )).rowCount ?? 0) > 0;
      fingerprintChecked = true;
      const channelCode = `${prefix.slice(-8)}CH`;
      const sku = `${prefix}-SKU`;
      testSkus.add(sku);
      const pasted = await call("/scanback/programs/preview", "POST", {
        text: `SKU\tRRP Inc\tGTM Inc\tDiscount\tDD Cost Ex\tT1 Ex\tGTM Buy Ex\t${account.code}\n${sku}\t110.00\t99.00\t10%\t60.00\t85.00\t70.25\t0`,
        ai_assist: false,
      });
      expect(pasted.status).toBe(200);
      expect(pasted.data.issues).toEqual([]);
      expect(pasted.data.rows[0]).toMatchObject({ sku, rrpIncCents: 11000, gtmIncCents: 9900, ddCostExCents: 6000, t1ExCents: 8500, gtmBuyCents: 7025, caps: [{ resellerId: account.id, quantity: 0 }] });
      const unknownPaste = await call("/scanback/programs/preview", "POST", {
        text: `SKU\tGTM Buy Ex\tUnknown reseller\n${sku}\t70.25\t4`, ai_assist: false,
      });
      expect(unknownPaste.data.issues.some((i: { column: string; blocking: boolean }) => i.column === "Unknown reseller" && i.blocking)).toBe(true);
      const remapped = await call("/scanback/programs/preview", "POST", {
        text: `SKU\tGTM Buy Ex\tUnknown reseller\n${sku}\t70.25\t4`, ai_assist: false,
        mapping: { fields: { sku: "SKU", gtmBuyCents: "GTM Buy Ex" }, customers: { "Unknown reseller": account.id }, ignored: [] },
      });
      expect(remapped.status).toBe(200);
      expect(remapped.data.issues).toEqual([]);
      const noPromotionSideEffect = (await call("/scanback/workspace")).data.programs
        .filter((p: { name: string }) => p.name.includes(prefix));
      expect(noPromotionSideEffect).toEqual([]);
      const batch = await stage([
        ["soh", `SKU,SOH,Sold Last 7 Days\n${sku},12,3\n`],
        ["claim", `Customer,Model,Serial,Date\n${channelCode},${sku},${prefix}A,01/01/2026\n`],
        ["evidence", `Account,SKU,Serial,Date,Invoice,Quantity,Unit Price\n${account.code},${sku},${prefix}A|${prefix}B,01/01/2026,${prefix}INV,2,100.00\n`],
        ["price", `SKU,Description,RRP Inc,DD Cost Ex,T1 Buy Ex\n${sku},Reference,110.01,65.27,90.99\n`],
        ["program", `SKU,GTM Buy Ex,${account.code}\n${sku},70.25,1\n`],
      ], account.id);
      expect(batch.errors).toEqual([]);
      expect(batch.uploads.map((e: CenterUpload) => e.kind).sort()).toEqual(["soh", "claim", "evidence", "price", "program"].sort());
      expect(batch.uploads.every((e: CenterUpload) => e.state === "preview")).toBe(true);
      const find = (kind: string) => batch.uploads.find((e: CenterUpload) => e.kind === kind) as CenterUpload;
      const soh = find("soh");
      expect(soh.summary).toMatchObject({ soh: 12, unitsSold: 3, skuCount: 1 });
      const corrected = await call(`/upload-center/${soh.id}`, "PATCH", { weekIso: "2026-W02" });
      expect(corrected.status).toBe(200);
      expect(corrected.data.weekIso).toBe("2026-W02");
      const refreshed = (await call("/upload-center")).data.uploads.find((u: CenterUpload) => u.id === soh.id);
      expect(refreshed.weekIso).toBe("2026-W02");
      const sohCommit = await call(`/upload-center/${soh.id}/commit`, "POST", {
        reseller_id: account.id, week_iso: "2026-W02", mappings: soh.sohReview?.mappings,
      });
      expect(sohCommit.status).toBe(200);
      expect(sohCommit.data.state).toBe("committed");
      const snapshot = await pool.query(
        "SELECT soh,sell_through_7d FROM inventory_snapshots WHERE upload_id=$1",
        [Number(soh.sourceId)],
      );
      expect(snapshot.rows).toHaveLength(1);
      expect(Number(snapshot.rows[0].soh)).toBe(12);
      expect(Number(snapshot.rows[0].sell_through_7d)).toBe(3);
      expect((await pool.query(
        "SELECT 1 FROM reseller_format_associations WHERE reseller_id=$1 AND fingerprint=$2",
        [account.id, sohFingerprint],
      )).rowCount).toBe(1);
      const evidence = find("evidence");
      expect(evidence.rowCount).toBe(1);
      expect(evidence.summary.serialCount).toBe(2);
      expect((await call(`/scanback/imports/${evidence.sourceId}/commit`, "POST", {})).status).toBe(200);
      expect((await call(`/upload-center/${evidence.id}`, "PATCH", { accountId: null })).status).toBe(409);
      const claim = find("claim");
      expect((await call(`/scanback/imports/${claim.sourceId}/commit`, "POST", {})).status).toBe(200);
      const learnedAccount = (await call("/resellers")).data.find((r: { id: number }) => r.id === account.id);
      expect(learnedAccount.aliases).toContain(channelCode);
      const price = find("price"), program = find("program");
      const uploadedProgram = await call("/scanback/programs/preview", "POST", { uploadId: program.id, ai_assist: false });
      expect(uploadedProgram.status).toBe(200);
      expect(uploadedProgram.data.issues).toEqual([]);
      expect(uploadedProgram.data.customerIds).toEqual([account.id]);
      expect(uploadedProgram.data.rows[0]).toMatchObject({ sku, gtmBuyCents: 7025, rrpIncCents: null, caps: [{ resellerId: account.id, quantity: 1 }] });
      expect((await call(`/upload-center/${price.id}/commit`, "POST", {})).status).toBe(200);
      expect((await call(`/upload-center/${program.id}/commit`, "POST", {})).status).toBe(200);
      const ws = (await call("/upload-center")).data;
      expect(ws.prices.find((p: any) => p.sku === sku)).toMatchObject({ rrpIncCents: 11001, ddCostExCents: 6527, t1BuyExCents: 9099 });
      expect(ws.programRows.find((p: any) => p.sku === sku)).toMatchObject({ gtmBuyCents: 7025 });
      expect(ws.uploads.find((p: CenterUpload) => p.id === claim.id).summary).toMatchObject({ ddRangeCount: 1, invoicedCount: 1, serialCount: 1 });
      expect((await call(`/upload-center/${evidence.id}`, "DELETE")).status).toBe(200);
      expect((await call("/scanback/workspace")).data.imports.some((item: { id: string }) => item.id === evidence.sourceId)).toBe(false);
      expect((await call(`/upload-center/${claim.id}`, "DELETE")).status).toBe(200);
      const scanbackAfterClaimDelete = (await call("/scanback/workspace")).data;
      expect(scanbackAfterClaimDelete.imports.some((item: { id: string }) => item.id === claim.sourceId)).toBe(false);
      expect(scanbackAfterClaimDelete.drafts.some((draft: any) => draft.settings.claimImportId === claim.sourceId)).toBe(false);

      expect((await call(`/upload-center/${price.id}`, "DELETE")).status).toBe(200);
      expect((await call("/upload-center")).data.prices.some((item: { sku: string }) => item.sku === sku)).toBe(false);
      expect((await call(`/upload-center/${program.id}`, "DELETE")).status).toBe(200);
      expect((await call("/upload-center")).data.uploads.some((item: CenterUpload) => item.id === program.id)).toBe(false);
      // Unsupported files remain pending; a user may explicitly reclassify.
      const unknown = await stage([["unknown", `Unrecognised,Value\nA,B\n`]], account.id);
      expect(unknown.uploads[0].kind).toBe("unknown");
      expect((await call(`/upload-center/${unknown.uploads[0].id}`, "PATCH", { kind: "history" })).status).toBe(400);
      expect((await call(`/upload-center/${unknown.uploads[0].id}`, "PATCH", { kind: "program" })).status).toBe(200);
      expect((await call(`/upload-center/${unknown.uploads[0].id}/commit`, "POST", {})).status).toBe(400);
      expect((await call(`/upload-center/${unknown.uploads[0].id}`, "DELETE")).status).toBe(200);

      const bulk = await stage([
        ["bulk-a", `Unrecognised,Value\n${prefix}A,one\n`],
        ["bulk-b", `Unrecognised,Value\n${prefix}B,two\n`],
      ], account.id);
      const bulkDelete = await call("/upload-center", "DELETE", { ids: bulk.uploads.map((upload: CenterUpload) => upload.id) });
      expect(bulkDelete.status).toBe(200);
      expect(bulkDelete.data.deletedIds.sort()).toEqual(bulk.uploads.map((upload: CenterUpload) => upload.id).sort());

      const mixedBatch = await stage([["bulk-committed", `Unrecognised,Value\n${prefix}C,three\n`]], account.id);
      const mixedDelete = await call("/upload-center", "DELETE", { ids: [mixedBatch.uploads[0].id, soh.id] });
      expect(mixedDelete.status).toBe(200);
      expect(mixedDelete.data.deletedIds).toHaveLength(2);
      expect((await pool.query("SELECT 1 FROM inventory_snapshots WHERE upload_id=$1", [Number(soh.sourceId)])).rowCount).toBe(0);
      expect((await pool.query("SELECT 1 FROM uploads WHERE id=$1", [Number(soh.sourceId)])).rowCount).toBe(0);
    } finally {
      // Test-owned references/evidence only; never use broad business-data cleanup.
      if (accountId != null) {
        await pool.query("UPDATE resellers SET aliases=$2::text[],filename_patterns=$3::text[] WHERE id=$1",
          [accountId, originalAliases, originalFilenamePatterns]);
        if (fingerprintChecked && !fingerprintWasPresent)
          await pool.query("DELETE FROM reseller_format_associations WHERE reseller_id=$1 AND fingerprint=$2",
            [accountId, sohFingerprint]);
      }
      await pool.query("DELETE FROM price_list WHERE upload_id=ANY($1::text[])", [[...ids]]);
      await pool.query("DELETE FROM center_uploads WHERE id=ANY($1::text[])", [[...ids]]);
      await pool.query("DELETE FROM scanback_imports WHERE id=ANY($1::text[])", [[...sources]]);
      await pool.query("DELETE FROM inventory_snapshots WHERE upload_id=ANY($1::int[])", [[...sohIds]]);
      await pool.query("DELETE FROM uploads WHERE id=ANY($1::int[])", [[...sohIds]]);
      await pool.query(`DELETE FROM parts p WHERE p.part_no=ANY($1::text[])
        AND NOT EXISTS (SELECT 1 FROM inventory_snapshots s WHERE s.part_id=p.id)`, [[...testSkus]]);
    }
  }, 60000);

  it("files an unfinished WK filename under the last completed week and blocks manual unfinished weeks", async () => {
    if (base !== "http://localhost:80/api") throw new Error("Use the local development proxy only.");
    const prefix = `WEEKGUARD${Date.now()}`;
    let cookie = "";
    let centerId: string | null = null;
    let sourceId: number | null = null;
    try {
      const login = await fetch(base + "/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: process.env.CHANNELPULSE_ADMIN_PASSWORD }),
      });
      expect(login.status).toBe(200);
      cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
        ["SKU", "SOH", "Sold Last 7 Days"], [`${prefix}-SKU`, 12, 3],
      ]), "SOH");
      const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
      const form = new FormData();
      form.append("files", new Blob([new Uint8Array(bytes)]), "2026_WK_46_Samsung_SSD_SOH_reports_-_KS.xlsx");
      form.append("ai_assist", "false");
      const stagedResponse = await fetch(base + "/upload-center/files", {
        method: "POST", headers: { Cookie: cookie }, body: form,
      });
      expect(stagedResponse.status).toBe(200);
      const staged = await stagedResponse.json() as { uploads: CenterUpload[]; errors: { name: string; error: string }[] };
      expect(staged.errors).toEqual([]);
      const upload = staged.uploads[0];
      expect(upload.weekIso).toBe("2026-W45");
      expect(upload.warnings).toContain("Filename said WK 46 (not finished yet). Filed as w/e 8 Nov — check.");
      centerId = upload.id;
      sourceId = upload.sourceId ? Number(upload.sourceId) : null;

      const manualResponse = await fetch(base + `/upload-center/${encodeURIComponent(upload.id)}`, {
        method: "PATCH", headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ weekIso: currentWeekIso() }),
      });
      expect(manualResponse.status).toBe(400);
      const manual = await manualResponse.json() as { error: string };
      expect(manual.error).toContain("has not ended in Australia/Sydney");
    } finally {
      if (centerId) await pool.query("DELETE FROM center_uploads WHERE id=$1", [centerId]);
      if (sourceId != null) {
        await pool.query("DELETE FROM inventory_snapshots WHERE upload_id=$1", [sourceId]);
        await pool.query("DELETE FROM uploads WHERE id=$1", [sourceId]);
      }
      await pool.query("DELETE FROM parts WHERE part_no=$1 AND NOT EXISTS (SELECT 1 FROM inventory_snapshots WHERE part_id=parts.id)", [`${prefix}-SKU`]);
    }
  }, 60000);

  it("corrects a committed SOH week only when the destination has no matching snapshots", async () => {
    if (base !== "http://localhost:80/api") throw new Error("Use the local development proxy only.");
    const prefix = `WEEKFIX${Date.now()}`;
    const sku = `${prefix}-SKU`;
    const fingerprint = computeHeaderFingerprint(["SKU", "SOH", "Sold Last 7 Days"]);
    let cookie = "";
    let accountId: number | null = null;
    let centerId: string | null = null;
    let sourceId: number | null = null;
    let conflictCenterId: string | null = null;
    let conflictSourceId: number | null = null;
    let originalPatterns: string[] = [];
    let fingerprintWasPresent = false;
    let fingerprintChecked = false;
    try {
      const login = await fetch(base + "/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: process.env.CHANNELPULSE_ADMIN_PASSWORD }),
      });
      expect(login.status).toBe(200);
      cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      const accounts = await fetch(base + "/resellers", { headers: { Cookie: cookie } })
        .then(r => r.json() as Promise<{ id: number; active: boolean }[]>);
      const account = accounts.find(r => r.active);
      if (!account) throw new Error("No active reseller is available for the integration test.");
      accountId = account.id;
      const original = (await pool.query("SELECT filename_patterns FROM resellers WHERE id=$1", [accountId])).rows[0];
      originalPatterns = [...(original.filename_patterns ?? [])];
      fingerprintWasPresent = ((await pool.query(
        "SELECT 1 FROM reseller_format_associations WHERE reseller_id=$1 AND fingerprint=$2",
        [accountId, fingerprint],
      )).rowCount ?? 0) > 0;
      fingerprintChecked = true;

      const form = new FormData();
      form.append("files", new Blob([`SKU,SOH,Sold Last 7 Days\n${sku},12,3\n`]), `${prefix}.csv`);
      form.append("accountId", String(accountId));
      form.append("weekIso", "2026-W40");
      form.append("ai_assist", "false");
      const stagedResponse = await fetch(base + "/upload-center/files", {
        method: "POST", headers: { Cookie: cookie }, body: form,
      });
      expect(stagedResponse.status).toBe(200);
      const staged = await stagedResponse.json() as { uploads: CenterUpload[]; errors: unknown[] };
      expect(staged.errors).toEqual([]);
      const upload = staged.uploads[0];
      centerId = upload.id;
      sourceId = Number(upload.sourceId);

      const commit = await fetch(base + `/upload-center/${encodeURIComponent(upload.id)}/commit`, {
        method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          reseller_id: accountId,
          week_iso: "2026-W40",
          mappings: upload.sohReview?.mappings,
        }),
      });
      const commitBody = await commit.json() as { error?: string };
      expect(commit.status, commitBody.error).toBe(200);

      const conflictForm = new FormData();
      conflictForm.append("files", new Blob([`SKU,SOH,Sold Last 7 Days\n${sku},15,4\n`]), `${prefix}-conflict.csv`);
      conflictForm.append("accountId", String(accountId));
      conflictForm.append("weekIso", "2026-W41");
      conflictForm.append("ai_assist", "false");
      const conflictStageResponse = await fetch(base + "/upload-center/files", {
        method: "POST", headers: { Cookie: cookie }, body: conflictForm,
      });
      expect(conflictStageResponse.status).toBe(200);
      const conflictStaged = await conflictStageResponse.json() as { uploads: CenterUpload[]; errors: unknown[] };
      expect(conflictStaged.errors).toEqual([]);
      const conflictUpload = conflictStaged.uploads[0];
      conflictCenterId = conflictUpload.id;
      conflictSourceId = Number(conflictUpload.sourceId);
      const conflictCommit = await fetch(base + `/upload-center/${encodeURIComponent(conflictUpload.id)}/commit`, {
        method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          reseller_id: accountId,
          week_iso: "2026-W41",
          mappings: conflictUpload.sohReview?.mappings,
        }),
      });
      expect(conflictCommit.status).toBe(200);

      const blocked = await fetch(base + `/upload-center/${encodeURIComponent(upload.id)}`, {
        method: "PATCH", headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ weekIso: "2026-W41" }),
      });
      expect(blocked.status).toBe(409);

      const correction = await fetch(base + `/upload-center/${encodeURIComponent(upload.id)}`, {
        method: "PATCH", headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ weekIso: "2026-W42" }),
      });
      expect(correction.status).toBe(200);
      expect((await correction.json() as CenterUpload).weekIso).toBe("2026-W42");
      const db = await pool.query(
        "SELECT u.week_iso AS upload_week,count(*) FILTER (WHERE s.week_iso='2026-W42')::int AS corrected_rows,recognition->'weekCorrections' AS corrections FROM uploads u JOIN inventory_snapshots s ON s.upload_id=u.id WHERE u.id=$1 GROUP BY u.id",
        [sourceId],
      );
      expect(db.rows[0]).toMatchObject({ upload_week: "2026-W42", corrected_rows: 1 });
      expect(db.rows[0].corrections).toHaveLength(1);
      expect(db.rows[0].corrections[0]).toMatchObject({ from: "2026-W40", to: "2026-W42", snapshotRows: 1 });
    } finally {
      if (centerId) await pool.query("DELETE FROM center_uploads WHERE id=$1", [centerId]);
      if (conflictCenterId) await pool.query("DELETE FROM center_uploads WHERE id=$1", [conflictCenterId]);
      if (sourceId != null) {
        await pool.query("DELETE FROM inventory_snapshots WHERE upload_id=$1", [sourceId]);
        await pool.query("DELETE FROM uploads WHERE id=$1", [sourceId]);
      }
      if (conflictSourceId != null) {
        await pool.query("DELETE FROM inventory_snapshots WHERE upload_id=$1", [conflictSourceId]);
        await pool.query("DELETE FROM uploads WHERE id=$1", [conflictSourceId]);
      }
      if (accountId != null) {
        await pool.query("UPDATE resellers SET filename_patterns=$2::text[] WHERE id=$1", [accountId, originalPatterns]);
        if (fingerprintChecked && !fingerprintWasPresent)
          await pool.query("DELETE FROM reseller_format_associations WHERE reseller_id=$1 AND fingerprint=$2", [accountId, fingerprint]);
      }
      await pool.query("DELETE FROM parts WHERE part_no=$1 AND NOT EXISTS (SELECT 1 FROM inventory_snapshots WHERE part_id=parts.id)", [sku]);
    }
  }, 60000);
});
