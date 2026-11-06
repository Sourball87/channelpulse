import { describe, it, expect } from "vitest";
import { pool } from "@workspace/db";
import * as XLSX from "xlsx";

// Opt-in: exercises the managed development API via its public proxy. Never
// points at production, and removes only IDs created by this test.
const base = process.env.SCANBACK_INTEGRATION_URL;
describe.skipIf(!base)("scanback HTTP financial workflow", () => {
  it("imports, verifies, approves atomically and preserves history snapshots", async () => {
    if (base !== "http://localhost:80/api") throw new Error("Integration test must use the local development proxy.");
    const prefix = `CPTEST${Date.now()}`;
    const ids = { programs: new Set<string>(), imports: new Set<string>(), drafts: new Set<string>(), batches: new Set<string>() };
    let sessionCookie = "";
    async function call(path: string, body?: unknown) {
      const headers: Record<string, string> = sessionCookie ? { Cookie: sessionCookie } : {};
      const response = await fetch(base + path, body instanceof FormData
        ? { method: "POST", body, headers }
        : body === undefined ? { headers }
          : { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      // The integration fixture deliberately asserts the raw wire shape rather
      // than trusting a generated client to cast the response under test.
      const data: any = await response.json();
      if (response.ok && data.id) {
        if (path === "/scanback/programs") ids.programs.add(data.id);
        if (path === "/scanback/imports/preview") ids.imports.add(data.id);
        if (path === "/scanback/verify") ids.drafts.add(data.id);
        if (path === "/scanback/approve") ids.batches.add(data.id);
      }
      return { status: response.status, data };
    }
    async function upload(kind: string, csv: string, name: string) {
      const form = new FormData();
      form.append("file", new Blob([csv], { type: "text/csv" }), `${prefix}-${name}.csv`);
      form.append("kind", kind);
      const result = await call("/scanback/imports/preview", form);
      expect(result.status, JSON.stringify(result.data)).toBe(200);
      return result.data;
    }
    async function commit(i: { id: string; errors: unknown[] }) {
      expect(i.errors).toEqual([]);
      const result = await call(`/scanback/imports/${i.id}/commit`, {});
      expect(result.status, JSON.stringify(result.data)).toBe(200);
      return result.data;
    }
    try {
      expect((await fetch(base + "/parts")).status).toBe(401);
      const badLogin = await fetch(base + "/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "not-the-password" }),
      });
      expect(badLogin.status).toBe(401);
      const login = await fetch(base + "/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: process.env.CHANNELPULSE_ADMIN_PASSWORD }),
      });
      expect(login.status).toBe(200);
      sessionCookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      expect(sessionCookie).toContain("channelpulse_session=");
      expect((await call("/auth/session")).data).toMatchObject({ authenticated: true });
      const accounts = (await call("/resellers")).data;
      const parts = (await call("/parts")).data;
      const a = accounts[0], other = accounts[1], part = parts[0];
      expect(a && other && part).toBeTruthy();
      const programInput = {
        name: prefix + " Main", start: "2026-09-01", end: "2026-09-30", notes: "", customerIds: [a.id],
        lines: [{ partId: part.id, gtmBuyCents: 7000, caps: [{ resellerId: a.id, quantity: 1 }] }],
      };
      let program = (await call("/scanback/programs", programInput)).data;
      expect(program.id).toBeTruthy();
      const sku = part.part_no ?? part.partNo;
      expect(sku).toBeTruthy();
      const header = "Invoice,Invoice Date,Account,SKU,Quantity,Serial,Unit Price,Our unit cost ex GST\n";
      const inv = (serial: string, reference = serial, account = a.code, qty = 1, date = "01/09/2026", price = "100.00") =>
        `${prefix}${reference},${date},${account},${sku},${qty},${prefix}${serial},${price},60.00\n`;
      const evidenceCsv = header + inv("A") + inv("E") + inv("B") + inv("B", "CREDIT-B", a.code, -1, "02/09/2026")
        + inv("C") + inv("C", "INV2-C", a.code, 1, "03/09/2026", "90.00") + inv("D", "D", other.code) + inv("H") + inv("I");
      const evidence = await commit(await upload("auto", evidenceCsv, "evidence"));
      expect(evidence.kind).toBe("evidence");
      const again = await upload("evidence", evidenceCsv, "same-evidence");
      expect(again).toMatchObject({ id: evidence.id, duplicate: true, state: "committed" });
      expect((await call(`/scanback/imports/${evidence.id}/remap`, {
        mapping: evidence.mapping, sheet: evidence.sheet, accountId: evidence.accountId, dateFormat: evidence.dateFormat,
      })).data.rows.length).toBeGreaterThan(0);
      expect((await call(`/scanback/imports/${evidence.id}/remap`, {
        mapping: evidence.mapping, sheet: evidence.sheet, accountId: other.id, dateFormat: evidence.dateFormat,
      })).status).toBe(400);
      const claimCsv = "Serial,SKU,Sale Date,Quantity\n" + ["A", "E", "B", "C", "D", "A", "MISSING"].map(s =>
        `${prefix}${s},${sku},20/09/2026,1\n`).join("");
      const claim = await commit(await upload("auto", claimCsv, "claim"));
      expect(claim.kind).toBe("claim");
      const settings = { programId: program.id, accountId: a.id, claimImportId: claim.id, basis: "sell", from: program.start, to: program.end };
      const later = await commit(await upload("claim",
        `Serial,SKU,Sale Date,Account\n${prefix}A,${sku},19/09/2026,${other.code}\n`, "later-customer-report"));
      expect(later.rows[0].reuseReason).toContain(claim.id);
      expect(later.warnings.some((w: string) => w.includes("reused serial rows"))).toBe(true);
      const intake = (await call("/upload-center")).data;
      expect(intake.uploads.find((u: { sourceId: string }) => u.sourceId === later.id).summary.serialCount).toBe(0);
      const laterDraft = (await call("/scanback/verify", { ...settings, claimImportId: later.id })).data;
      expect(laterDraft.results[0]).toMatchObject({ trackingColor: "red", include: false, selectable: false });
      expect(laterDraft.results[0].reason).toContain(claim.id);
      const soldTrail = (await call(`/scanback/serials/${prefix}A`)).data;
      expect(soldTrail.status).toBe("SOLD");
      expect(soldTrail.events.filter((e: { kind: string }) => e.kind === "sold")).toHaveLength(3);
      expect(soldTrail.events.filter((e: { kind: string; reused: boolean }) => e.kind === "sold" && e.reused)).toHaveLength(2);
      expect(soldTrail.events.find((e: { kind: string }) => e.kind === "invoice"))
        .toMatchObject({ accountId: a.id, unitPriceCents: 10000, costCents: 6000 });
      let draft = (await call("/scanback/verify", settings)).data;
      expect(draft.totalCents).toBe(3000);
      expect(draft.results.map((r: { status: string }) => r.status)).toEqual(["eligible", "rejected", "rejected", "review", "rejected", "rejected", "rejected"]);
      draft = (await call("/scanback/verify", { ...settings, draftId: draft.id, selectedRows: [1] })).data;
      expect(draft.results[1]).toMatchObject({ serial: prefix + "E", include: true, amountCents: 3000 });
      expect(draft.results[0].include).toBe(false);
      program = (await call("/scanback/programs", { ...program, notes: "Changed after verification" })).data;
      expect((await call("/scanback/approve", { draftId: draft.id, token: draft.token, reference: prefix })).status).toBe(409);
      draft = (await call("/scanback/verify", { ...settings, draftId: draft.id, selectedRows: [1] })).data;
      const approvals = await Promise.all([1, 2].map(() => call("/scanback/approve", { draftId: draft.id, token: draft.token, reference: prefix + " approved" })));
      expect(approvals.map(r => r.status)).toEqual([200, 200]);
      expect(approvals[0].data.id).toBe(approvals[1].data.id);
      const approved = approvals[0].data;
      expect(approved.totalCents).toBe(3000);
      const after = (await call("/scanback/verify", settings)).data;
      expect(after.results[0].reason).toContain("cap reached");
      expect(after.results[1].reason).toContain("Already approved");
      const second = (await call("/scanback/programs", {
        ...programInput, name: prefix + " Other", lines: [{ ...programInput.lines[0], caps: [] }],
      })).data;
      const otherDraft = (await call("/scanback/verify", { ...settings, programId: second.id })).data;
      expect(otherDraft.results[1].reason).toContain("Already approved");
      // Two different drafts racing for the same unused serial must not both win.
      const raceA = (await call("/scanback/verify", { ...settings, programId: second.id, selectedRows: [0] })).data;
      const raceB = (await call("/scanback/verify", { ...settings, programId: second.id, selectedRows: [0] })).data;
      const race = await Promise.all([raceA, raceB].map(d => call("/scanback/approve", { draftId: d.id, token: d.token, reference: prefix + " race" })));
      expect(race.map(r => r.status).sort()).toEqual([200, 409]);
      expect(Number((await pool.query("SELECT count(*) FROM scanback_approved_serials WHERE serial=$1", [prefix + "A"])).rows[0].count)).toBe(1);
      const claimedTrail = (await call(`/scanback/serials/${prefix}A`)).data;
      expect(claimedTrail.status).toBe("CLAIMED");
      expect(claimedTrail.events.find((e: { kind: string }) => e.kind === "claimed"))
        .toMatchObject({ promotion: second.name, amountCents: 3000, accountId: a.id });
      const unknownTrail = await call(`/scanback/serials/${prefix}UNKNOWN`);
      expect(unknownTrail.data).toMatchObject({ status: "UNKNOWN", events: [] });
      // A different file containing identical financial events must not add units.
      const overlap = await upload("evidence", header + inv("A"), "overlap");
      expect(overlap.recordCount).toBe(0); expect(overlap.warnings.join(" ")).toContain("ignored");
      await commit(overlap);
      const conflict = await upload("evidence", header + inv("A", "A", a.code, 1, "01/09/2026", "110.00"), "conflict");
      expect(conflict.errors.length).toBeGreaterThan(0);
      expect((await call(`/scanback/imports/${conflict.id}/commit`, {})).status).toBe(400);
      const pastName = prefix + " Historical";
      const history = await upload("auto", `Serial,SKU,Date,Account,Amount,Promotion,Claim Reference\n${prefix}H,${sku},14/09/2026,${a.code},12.34,${pastName},${prefix}-old\n`, "history");
      expect(history.kind).toBe("history");
      await commit(history);
      const historicalProgram = (await call("/scanback/programs", { ...programInput, name: pastName })).data;
      const histClaim = await commit(await upload("claim", `Serial,SKU,Sale Date\n${prefix}H,${sku},20/09/2026\n${prefix}I,${sku},20/09/2026\n`, "history-claim"));
      const histDraft = (await call("/scanback/verify", { ...settings, programId: historicalProgram.id, claimImportId: histClaim.id })).data;
      expect(histDraft.results[0].reason).toContain("Already approved");
      expect(histDraft.results[1].reason).toContain("cap reached");
      const doubleHistory = await upload("history", `Serial,SKU,Date,Account,Amount,Promotion,Claim Reference\n${prefix}H,${sku},14/09/2026,${a.code},12.34,${pastName},${prefix}-old-2\n`, "history-duplicate");
      expect(doubleHistory.errors.length).toBeGreaterThan(0);
      expect((await call(`/scanback/imports/${doubleHistory.id}/commit`, {})).status).toBe(400);
      program = (await call("/scanback/programs", { ...program, lines: [{ ...program.lines[0], gtmBuyCents: 5000 }] })).data;
      const exportResponse = await fetch(base + `/scanback/batches/${approved.id}/export/xlsx`, {
        headers: { Cookie: sessionCookie },
      });
      expect(exportResponse.status).toBe(200);
      const book = XLSX.read(Buffer.from(await exportResponse.arrayBuffer()), { type: "buffer" });
      const exportRows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[book.SheetNames[0]], { header: 1 });
      const paid = exportRows.find(r => r[0] === prefix + "E")!;
      expect(paid[6]).toBe(70); expect(paid[7]).toBe(30); // original snapshot, not edited GTM 50.
      const workspace = (await call("/scanback/workspace")).data;
      const past = workspace.batches.filter((b: { rows: { serial: string }[] }) => b.rows.some(r => r.serial.startsWith(prefix)));
      past.forEach((b: { id: string }) => ids.batches.add(b.id));
      expect(past.some((b: { historical: boolean; totalCents: number }) => b.historical && b.totalCents === 1234)).toBe(true);
      expect(workspace.drafts.some((d: { id: string }) => d.id === draft.id)).toBe(false);
      // Native Pronto POS scopes evidence without hiding cross-scope ownership.
      const prontoHeader = "Invoice No,Invoice Date,Account Code,Reseller Name,Stock Code,Ship Qty,Serial Number,Item Price,Line Price Ex,EU Email\n";
      const pr = (serial: string, sourceCode = "SOURCE1", stock = sku) =>
        `${prefix}${serial},01/09/2026,${sourceCode},Computer Alliance,${stock},1,${serial ? prefix + serial : ""},100.00,100.00,unused@example.invalid\n`;
      let native = await upload("auto", prontoHeader + pr("NATIVEGOOD") + pr("NATIVEHELD") + pr("UNKNOWN-SKU", "SOURCE1", "NOT-IN-CATALOGUE") + pr(""), "pronto");
      expect(native.kind).toBe("evidence");
      expect(native.pronto).toMatchObject({ sourceRows: 4, sourceSerialEvents: 3, includedSourceRows: 0 });
      expect(native.errors.length).toBeGreaterThan(0); expect(native.rows).toEqual([]);
      const nativeOptions = { mapping: native.mapping, sheet: native.sheet, dateFormat: native.dateFormat, accountId: null, prontoAccounts: { SOURCE1: a.id } };
      native = (await call(`/scanback/imports/${native.id}/remap`, nativeOptions)).data;
      expect(native.pronto).toMatchObject({ includedSourceRows: 3, excludedSourceRows: 1 });
      expect(native.rows[0]).toMatchObject({ unitPriceCents: 10000, accountId: a.id, sourceRow: 2 });
      await commit(native);
      expect((await call(`/scanback/imports/${native.id}/remap`, { ...nativeOptions, prontoAccounts: { SOURCE1: other.id } })).status).toBe(400);
      const retained = (await pool.query("SELECT raw_sheets FROM scanback_imports WHERE id=$1", [native.id])).rows[0].raw_sheets;
      expect(JSON.stringify(retained)).not.toContain("EU Email");
      const nativeClaim = await commit(await upload("claim", `Serial,SKU,Sale Date\n${prefix}NATIVEGOOD,${sku},20/09/2026\n${prefix}NATIVEHELD,${sku},20/09/2026\n`, "native-claim"));
      const nativeSettings = { ...settings, programId: second.id, claimImportId: nativeClaim.id };
      const beforeScopeChange = (await call("/scanback/verify", nativeSettings)).data;
      expect(beforeScopeChange.totalCents).toBe(6000);
      let extra = await upload("evidence", prontoHeader + pr("OTHERGOOD") + pr("NATIVEHELD", "OUTSIDE"), "pronto-ownership");
      extra = (await call(`/scanback/imports/${extra.id}/remap`, { ...nativeOptions, sheet: extra.sheet, mapping: extra.mapping })).data;
      await commit(extra);
      expect((await call("/scanback/approve", { draftId: beforeScopeChange.id, token: beforeScopeChange.token, reference: prefix + " stale ownership" })).status).toBe(409);
      const held = (await call("/scanback/verify", { ...nativeSettings, draftId: beforeScopeChange.id })).data;
      expect(held.totalCents).toBe(3000);
      expect(held.results[1]).toMatchObject({ status: "review", include: false });
      expect(held.results[1].reason).toContain("excluded Pronto");
      const customSku = `${prefix}-CUSTOM`;
      const customProgramResponse = await call("/scanback/programs", {
        name: prefix + " Custom SKU", start: "2026-09-01", end: "2026-09-30", notes: "", customerIds: [a.id],
        lines: [{ sku: customSku, partId: null, gtmBuyCents: 5000, caps: [{ resellerId: a.id, quantity: 1 }] }],
      });
      expect(customProgramResponse.status).toBe(200);
      const customProgram = customProgramResponse.data;
      expect(customProgram.lines[0]).toMatchObject({ sku: customSku, partId: null });
      const customEvidence = await commit(await upload("auto",
        `Invoice,Invoice Date,Account,SKU,Quantity,Serial,Unit Price\n${prefix}-CS1,01/09/2026,${a.code},${customSku},1,${prefix}CS1,100.00\n${prefix}-CS2,01/09/2026,${a.code},${customSku},1,${prefix}CS2,100.00\n${prefix}-CS3,01/09/2026,${a.code},${customSku},1,${prefix}CS3,100.00\n`,
        "custom-sku-evidence"));
      expect(customEvidence.rows[0].sku).toBe(customSku);
      expect(customEvidence.warnings.some((w: string) => w.includes("No product SKUs were created"))).toBe(true);
      const customClaim = await commit(await upload("claim",
        `Serial,SKU,Sale Date\n${prefix}CS1,${customSku},20/09/2026\n${prefix}CS2,${customSku},20/09/2026\n`, "custom-sku-claim"));
      const customSettings = { ...settings, programId: customProgram.id, claimImportId: customClaim.id, basis: "invoice" };
      const customDraft = (await call("/scanback/verify", customSettings)).data;
      expect(customDraft.totalCents).toBe(5000);
      expect(customDraft.results.map((r: { status: string }) => r.status)).toEqual(["eligible", "rejected"]);
      expect(customDraft.results[1].reason).toContain("cap reached");
      const customApproval = await call("/scanback/approve", { draftId: customDraft.id, token: customDraft.token, reference: prefix + "-custom-approval" });
      expect(customApproval.status).toBe(200);
      const approvalWorkspace = (await call("/scanback/workspace")).data;
      const stats = approvalWorkspace.programStats;
      const approvedSnapshot = approvalWorkspace.batches.find((b: { id: string }) => b.id === customApproval.data.id);
      expect(stats.find((s: { programId: string }) => s.programId === customProgram.id))
        .toMatchObject({ accountId: a.id, sku: customSku, count: 1, amountCents: 5000 });
      const removal = await call("/scanback/programs", {
        ...customProgram, customerIds: [other.id],
        lines: customProgram.lines.map((line: Record<string, unknown>) => ({ ...line, caps: [{ resellerId: other.id, quantity: null }] })),
      });
      expect(removal.status).toBe(409);
      expect(removal.data.error).toContain("approved claims");
      const referenceEdit = await call("/scanback/programs", {
        ...customProgram, lines: customProgram.lines.map((line: Record<string, unknown>) => ({
          ...line, rrpIncCents: 11001, gtmIncCents: 9900, ddCostExCents: 6000, t1ExCents: 8500,
        })),
      });
      expect(referenceEdit.status).toBe(200);
      expect(referenceEdit.data.version).toBe(customProgram.version + 1);
      expect(referenceEdit.data.lines[0]).toMatchObject({ rrpIncCents: 11001, gtmIncCents: 9900, ddCostExCents: 6000, t1ExCents: 8500 });
      const staleReference = await call("/scanback/programs", customProgram);
      expect(staleReference.status).toBe(409);
      const unchangedBatch = (await call("/scanback/workspace")).data.batches.find((b: { id: string }) => b.id === customApproval.data.id);
      expect(unchangedBatch).toEqual(approvedSnapshot);
      const customLedger = await pool.query("SELECT part_id,sku FROM scanback_approved_serials WHERE serial=$1", [`${prefix}CS1`]);
      expect(customLedger.rows[0]).toMatchObject({ part_id: null, sku: customSku });
      const customClaimNext = await commit(await upload("claim",
        `Serial,SKU,Sale Date\n${prefix}CS3,${customSku},20/09/2026\n`, "custom-sku-cap-claim"));
      const exhausted = (await call("/scanback/verify", { ...customSettings, claimImportId: customClaimNext.id })).data;
      expect(exhausted.results[0].reason).toContain("cap reached");
      expect((await call("/auth/logout", {})).status).toBe(200);
      sessionCookie = "";
      expect((await fetch(base + "/parts")).status).toBe(401);
    } finally {
      // Track historical batches even if an assertion fails before workspace read.
      const historyBatches = await pool.query("SELECT id FROM scanback_batches WHERE payload->>'programName' LIKE $1", [prefix + "%"]);
      historyBatches.rows.forEach(r => ids.batches.add(r.id));
      const cleanup = await pool.connect();
      await cleanup.query("BEGIN");
      try {
        await cleanup.query("DELETE FROM scanback_approved_serials WHERE batch_id=ANY($1::text[])", [[...ids.batches]]);
        await cleanup.query("DELETE FROM scanback_batches WHERE id=ANY($1::text[])", [[...ids.batches]]);
        await cleanup.query("DELETE FROM scanback_drafts WHERE id=ANY($1::text[])", [[...ids.drafts]]);
        await cleanup.query("DELETE FROM scanback_imports WHERE id=ANY($1::text[])", [[...ids.imports]]);
        await cleanup.query("DELETE FROM scanback_programs WHERE id=ANY($1::text[])", [[...ids.programs]]);
        await cleanup.query("COMMIT");
      } catch (e) { await cleanup.query("ROLLBACK"); throw e; }
      finally { cleanup.release(); }
    }
  }, 90_000);
});
