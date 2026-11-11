import { describe, it, expect } from "vitest";
import { pool } from "@workspace/db";
import * as XLSX from "xlsx";
import { maskCustomerText } from "./customer-display";

// Opt-in: exercises the managed development API via its public proxy. Never
// points at production, and removes only IDs created by this test.
const base = process.env.SCANBACK_INTEGRATION_URL;
describe.skipIf(!base)("scanback HTTP financial workflow", () => {
  it("imports, verifies, approves atomically and preserves history snapshots", async () => {
    if (base !== "http://localhost:80/api") throw new Error("Integration test must use the local development proxy.");
    const prefix = `CPTEST${Date.now()}`;
    const ids = {
      programs: new Set<string>(), imports: new Set<string>(), drafts: new Set<string>(),
      batches: new Set<string>(), audits: new Set<number>(),
    };
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
      const workbookResponse = await fetch(base + "/scanback/export", { headers: { Cookie: sessionCookie } });
      expect(workbookResponse.status).toBe(200);
      const workbook = XLSX.read(await workbookResponse.arrayBuffer(), { type: "array" });
      expect(workbook.SheetNames).toEqual([
        "Programs", "Approved batches", "Approved serials", "Credit resolutions", "Resellers",
      ]);
      const weeklyResponse = await fetch(base + "/scanback/exports/weekly", { headers: { Cookie: sessionCookie } });
      expect(weeklyResponse.status).toBe(200);
      const weeklyExports = await weeklyResponse.json() as { name: string }[];
      expect(Array.isArray(weeklyExports)).toBe(true);
      if (weeklyExports[0]) {
        const backup = await fetch(base + `/scanback/exports/weekly/${encodeURIComponent(weeklyExports[0].name)}`, {
          headers: { Cookie: sessionCookie },
        });
        expect(backup.status).toBe(200);
        expect(backup.headers.get("content-type")).toContain("spreadsheetml.sheet");
      }
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
      const octoberProgram = (await call("/scanback/programs", {
        ...programInput, name: prefix + " October", start: "2026-10-01", end: "2026-10-31",
      })).data;
      const sku = part.part_no ?? part.partNo;
      expect(sku).toBeTruthy();
      const header = "Invoice,Invoice Date,Account,SKU,Quantity,Serial,Unit Price,Our unit cost ex GST\n";
      const inv = (serial: string, reference = serial, account = a.code, qty = 1, date = "01/09/2026", price = "100.00") =>
        `${prefix}${reference},${date},${account},${sku},${qty},${prefix}${serial},${price},60.00\n`;
      const evidenceCsv = header + inv("A") + inv("E") + inv("B") + inv("B", "CREDIT-B", a.code, -1, "02/09/2026")
        + inv("C") + inv("C", "INV2-C", a.code, 1, "03/09/2026", "90.00") + inv("D", "D", other.code) + inv("H") + inv("I")
        + inv("SPLIT-SEP") + inv("SPLIT-OCT", "SPLIT-OCT", a.code, 1, "05/10/2026");
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
      const claimRow = (serial: string, date = "20/09/2026") => `${serial},${sku},${date},1,${a.code}`;
      const claimCsv = "Serial,SKU,Sale Date,Quantity,Account\n" + [
        claimRow(`${prefix}A`),
        claimRow(""),
        claimRow(`${prefix}E`),
        claimRow(`${prefix}B`),
        claimRow(""),
        claimRow(`${prefix}C`),
        claimRow("TOTAL"),
        claimRow(`${prefix}D`),
        claimRow(`${prefix}A`),
        claimRow(`${prefix}MISSING`),
        claimRow(`${prefix}SPLIT-SEP`),
        claimRow(`${prefix}SPLIT-OCT`, "10/10/2026"),
      ].join("\n") + "\n";
      const claimPreview = await upload("auto", claimCsv, "claim");
      expect(claimPreview.errors).toEqual([]);
      expect(claimPreview.recordCount).toBe(9);
      expect(claimPreview.missingSerialCount).toBe(3);
      expect(claimPreview.warnings).toContain("3 rows have no serial (rows 3, 6, 8) — skipped");
      const repeated = claimPreview.rows.find((row: any) => row.serial === `${prefix}A` && row.reuseReason);
      expect(repeated.reuseReason).toContain("source row 10 repeats its first occurrence on source row 2");
      expect(claimPreview.warnings.some((warning: string) => warning.includes("source row 10") && warning.includes("source row 2"))).toBe(true);
      const claim = await commit(claimPreview);
      expect(claim.kind).toBe("claim");
      expect(claim.state).toBe("committed");
      expect(claim.rows).toHaveLength(9);
      expect(claim.rows.every((row: any) => row.serial)).toBe(true);
      const automaticDrafts = (await call("/scanback/workspace")).data.drafts
        .filter((draft: any) => draft.autoGenerated && draft.settings.claimImportId === claim.id);
      expect(automaticDrafts).toHaveLength(2);
      for (const draft of automaticDrafts) ids.drafts.add(draft.id);
      const septemberDraft = automaticDrafts.find((draft: any) => draft.settings.programId === program.id);
      const octoberDraft = automaticDrafts.find((draft: any) => draft.settings.programId === octoberProgram.id);
      expect(septemberDraft.results.some((row: any) => row.serial === `${prefix}SPLIT-SEP`)).toBe(true);
      expect(septemberDraft.results.some((row: any) => row.serial === `${prefix}SPLIT-OCT`)).toBe(false);
      expect(octoberDraft.results).toHaveLength(1);
      expect(octoberDraft.results[0]).toMatchObject({
        serial: `${prefix}SPLIT-OCT`, status: "eligible", unitPriceCents: 10000,
        gtmBuyCents: 7000, amountCents: 3000, include: true,
      });
      const settings = { programId: program.id, accountId: a.id, claimImportId: claim.id, basis: "sell", from: program.start, to: program.end };
      const later = await commit(await upload("claim",
        `Serial,SKU,Sale Date,Account\n${prefix}A,${sku},19/09/2026,${other.code}\n`, "later-customer-report"));
      expect(later.rows[0].reuseReason).toContain(claim.id);
      expect(later.rows[0].reuseReason).toContain("source row 2");
      expect(later.warnings.some((w: string) => w.includes("red because"))).toBe(true);
      const intake = (await call("/upload-center")).data;
      expect(intake.uploads.find((u: { sourceId: string }) => u.sourceId === later.id).summary.serialCount).toBe(0);
      const claimCard = intake.uploads.find((u: { sourceId: string }) => u.sourceId === claim.id);
      expect(claimCard.summary.missingSerialCount).toBe(3);
      expect(claimCard.warnings).toContain("3 rows have no serial (rows 3, 6, 8) — skipped");
      const laterDraft = (await call("/scanback/verify", { ...settings, claimImportId: later.id })).data;
      expect(laterDraft.results[0]).toMatchObject({ trackingColor: "red", include: false, selectable: false });
      expect(laterDraft.results[0].reason).toContain(claim.id);
      expect(laterDraft.results[0].reason).toContain("source row 2");
      const soldTrail = (await call(`/scanback/serials/${prefix}A`)).data;
      expect(soldTrail.status).toBe("SOLD");
      expect(soldTrail.events.filter((e: { kind: string }) => e.kind === "sold")).toHaveLength(3);
      expect(soldTrail.events.filter((e: { kind: string; reused: boolean }) => e.kind === "sold" && e.reused)).toHaveLength(2);
      expect(soldTrail.events.find((e: { kind: string }) => e.kind === "invoice"))
        .toMatchObject({ accountId: a.id, unitPriceCents: 10000, costCents: 6000 });
      let draft = (await call("/scanback/verify", settings)).data;
      expect(draft.totalCents).toBe(3000);
      expect(draft.results[5]).toMatchObject({ trackingColor: "red", include: false, selectable: false });
      expect(draft.results[5].reason).toContain("first occurrence is on source row 2");
      expect(draft.results.map((r: { status: string }) => r.status)).toEqual([
        "eligible", "rejected", "rejected", "review", "rejected", "rejected", "rejected", "rejected", "rejected",
      ]);
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
      const retiredHistory = new FormData();
      retiredHistory.append("file", new Blob([
        `Serial,SKU,Date,Account,Amount,Promotion,Claim Reference\n${prefix}H,${sku},14/09/2026,${a.code},12.34,Past promotion,${prefix}-old\n`,
      ]), `${prefix}-history.csv`);
      retiredHistory.append("kind", "auto");
      const retired = await call("/scanback/imports/preview", retiredHistory);
      expect(retired.status).toBe(400);
      expect(retired.data.error).toContain("Historical approved claims uploads are retired");
      await commit(await upload("evidence", header + inv("SAME", `${prefix}-SAME`, a.code), "same-customer-evidence"));
      const sameOld = await commit(await upload("claim",
        `Serial,SKU,Sale Date,Account\n${prefix}SAME,${sku},20/09/2026,${a.code}\n`, "same-customer-old-report"));
      const sameNew = await commit(await upload("claim",
        `Serial,SKU,Sale Date,Account\n${prefix}SAME,${sku},21/09/2026,${a.code}\n`, "same-customer-resend"));
      expect(sameNew.rows[0].reuseReason).toContain("Also in earlier report");
      const sameDraft = (await call("/scanback/verify", { ...settings, programId: second.id, claimImportId: sameNew.id })).data;
      expect(sameDraft.results[0]).toMatchObject({ status: "eligible", trackingColor: "amber", include: true });
      const superseded = await call(`/scanback/imports/${sameOld.id}/supersede`, {});
      expect(superseded.status).toBe(200);
      expect(superseded.data.state).toBe("superseded");
      const refreshedSameDraft = (await call("/scanback/verify", { ...settings, programId: second.id, claimImportId: sameNew.id })).data;
      expect(refreshedSameDraft.results[0]).toMatchObject({ status: "eligible", trackingColor: "green", include: true });
      const reportCenter = (await call("/upload-center")).data;
      expect(reportCenter.uploads.find((u: { sourceId: string }) => u.sourceId === sameOld.id))
        .toMatchObject({ state: "superseded", summary: { serialCount: 0 } });
      const approvedAgain = await commit(await upload("claim",
        `Serial,SKU,Sale Date,Account\n${prefix}A,${sku},20/09/2026,${a.code}\n`, "approved-after-supersede"));
      const stillBlocked = (await call("/scanback/verify", { ...settings, programId: second.id, claimImportId: approvedAgain.id })).data;
      expect(stillBlocked.results[0]).toMatchObject({ trackingColor: "red", include: false });
      expect(stillBlocked.results[0].reason).toContain("Already approved");
      program = (await call("/scanback/programs", { ...program, lines: [{ ...program.lines[0], gtmBuyCents: 5000 }] })).data;
      const exportResponse = await fetch(base + `/scanback/batches/${approved.id}/export/xlsx`, {
        headers: { Cookie: sessionCookie },
      });
      expect(exportResponse.status).toBe(200);
      const book = XLSX.read(Buffer.from(await exportResponse.arrayBuffer()), { type: "buffer" });
      const exportRows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[book.SheetNames[0]], { header: 1 });
      const paid = exportRows.find(r => r[0] === prefix + "E")!;
      expect(paid[6]).toBe(70); expect(paid[7]).toBe(30); // original snapshot, not edited GTM 50.
      const legacyBatchId = `${prefix}-legacy-batch`;
      ids.batches.add(legacyBatchId);
      await pool.query("INSERT INTO scanback_batches(id,payload) VALUES($1,$2::jsonb)", [legacyBatchId, JSON.stringify({
        id: legacyBatchId, reference: `${prefix}-legacy`, programName: "Past promotion", accountCode: a.code,
        createdAt: new Date().toISOString(), totalCents: 1234, approvedCount: 1, historical: true,
        basis: "sell", from: "2026-09-01", to: "2026-09-30",
        rows: [{ rowIndex: 0, serial: `${prefix}H`, sku, date: "2026-09-14", invoice: "", invoiceDate: "",
          unitPriceCents: 1234, gtmBuyCents: null, amountCents: 1234, quantity: 1, status: "eligible",
          reason: "legacy approval", include: true, selectable: false, source: "historical import" }],
      })]);
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
      const remappedToOtherActiveReseller = await call(`/scanback/imports/${native.id}/remap`, {
        ...nativeOptions, prontoAccounts: { SOURCE1: other.id },
      });
      expect(remappedToOtherActiveReseller.status).toBe(200);
      expect(remappedToOtherActiveReseller.data.pronto.accounts).toContainEqual(
        expect.objectContaining({ code: "SOURCE1", accountId: other.id }),
      );
      native = (await call(`/scanback/imports/${native.id}/remap`, nativeOptions)).data;
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
      const creditSku = `${prefix}-CREDIT`;
      const creditProgram = (await call("/scanback/programs", {
        name: prefix + " Unmatched credit", start: "2026-09-01", end: "2026-09-30", notes: "", customerIds: [a.id],
        lines: [{ sku: creditSku, partId: null, gtmBuyCents: 5000, caps: [] }],
      })).data;
      const creditPr = (reference: string, serial: string, quantity: number) =>
        `${prefix}-${reference},01/09/2026,SOURCE1,Computer Alliance,${creditSku},${quantity},${serial ? prefix + serial : ""},100.00,${(quantity * 100).toFixed(2)},unused@example.invalid\n`;
      const remapPronto = async (imp: any) => (await call(`/scanback/imports/${imp.id}/remap`, {
        ...nativeOptions, sheet: imp.sheet, mapping: imp.mapping,
      })).data;
      let creditSale = await upload("auto", prontoHeader + creditPr("CREDIT-SALE", "CREDITGOOD", 1), "credit-sale");
      creditSale = await remapPronto(creditSale);
      await commit(creditSale);
      let missingCredit = await upload("auto", prontoHeader + creditPr("CREDIT-REF", "", -1), "missing-serial-credit");
      expect(missingCredit.errors.length).toBeGreaterThan(0);
      missingCredit = await remapPronto(missingCredit);
      expect(missingCredit).toMatchObject({ recordCount: 0, errors: [] });
      expect(missingCredit.pronto.excludedCounts["Unmatched credit — no serial number"]).toBe(1);
      await commit(missingCredit);
      const creditClaim = await commit(await upload("claim",
        `Serial,SKU,Sale Date,Account\n${prefix}CREDITGOOD,${creditSku},20/09/2026,${a.code}\n`, "unmatched-credit-claim"));
      const creditSettings = { ...settings, programId: creditProgram.id, claimImportId: creditClaim.id, basis: "invoice" };
      const heldByCredit = (await call("/scanback/verify", creditSettings)).data;
      expect(heldByCredit.results[0]).toMatchObject({ status: "review", trackingColor: "amber", include: false });
      expect(heldByCredit.results[0].reason).toContain("unmatched Pronto credit");
      expect(heldByCredit.results[0].reason).toContain(`${prefix}-CREDIT-REF`);
      expect(heldByCredit.results[0].reason).toContain("2026-09-01");
      let creditCenter = (await call("/upload-center")).data;
      expect(creditCenter.unmatchedCredits).toContainEqual(expect.objectContaining({
        importId: missingCredit.id, sourceRow: 2, accountId: a.id, sku: creditSku,
        invoice: `${prefix}-CREDIT-REF`, date: "2026-09-01", quantity: -1,
      }));
      const serialResolution = await call(`/scanback/pronto-credits/${missingCredit.id}/2/resolve`, {
        mode: "serials", serials: [`${prefix}CREDITGOOD`],
      });
      expect(serialResolution.status).toBe(200);
      expect(serialResolution.data).toMatchObject({
        sourceRow: 2, mode: "serials", serials: [`${prefix}CREDITGOOD`], resolvedBy: "admin",
      });
      const afterSerialResolution = (await call("/scanback/verify", creditSettings)).data;
      expect(afterSerialResolution.results[0].reason).toContain("Credited / returned");
      expect(afterSerialResolution.results[0].reason).not.toContain("unmatched Pronto credit");
      const auditedSerialResolution = (await pool.query(
        "SELECT payload->'prontoCreditResolutions' AS resolutions FROM scanback_imports WHERE id=$1", [missingCredit.id],
      )).rows[0].resolutions;
      expect(auditedSerialResolution).toMatchObject([{
        sourceRow: 2, mode: "serials", serials: [`${prefix}CREDITGOOD`], resolvedBy: "admin",
      }]);

      let oldCredit = await upload("auto", prontoHeader + creditPr("CREDIT-OLD", "", -1) +
        creditPr("CREDIT-OLD-SALE", "OLDUNIQUE", 1) +
        creditPr("CREDIT-SHARED-SALE", "SHAREDSERIAL", 1), "old-unmatched-credit");
      oldCredit = await remapPronto(oldCredit);
      await commit(oldCredit);
      creditCenter = (await call("/upload-center")).data;
      expect(creditCenter.unmatchedCredits).toContainEqual(expect.objectContaining({
        importId: oldCredit.id, invoice: `${prefix}-CREDIT-OLD`, date: "2026-09-01",
      }));
      let overlapCredit = await upload("auto", prontoHeader + creditPr("CREDIT-OLD", "", -1) +
        creditPr("CREDIT-OVERLAP-SALE", "OVERLAPUNIQUE", 1) +
        creditPr("CREDIT-SHARED-SALE", "SHAREDSERIAL", 1), "old-unmatched-overlap");
      overlapCredit = await remapPronto(overlapCredit);
      await commit(overlapCredit);
      const supersededOld = (await pool.query("SELECT payload FROM scanback_imports WHERE id=$1", [oldCredit.id])).rows[0].payload;
      expect(supersededOld.state).toBe("superseded");
      expect(supersededOld.rows.map((r: { serial: string }) => r.serial)).toContain(`${prefix}OLDUNIQUE`);
      expect(supersededOld.rows.map((r: { serial: string }) => r.serial)).not.toContain(`${prefix}SHAREDSERIAL`);
      const overlapPayload = (await pool.query("SELECT payload FROM scanback_imports WHERE id=$1", [overlapCredit.id])).rows[0].payload;
      expect(overlapPayload.rows.filter((r: { serial: string }) => r.serial === `${prefix}SHAREDSERIAL`)).toHaveLength(1);
      creditCenter = (await call("/upload-center")).data;
      const overlappingCredits = creditCenter.unmatchedCredits.filter((credit: { invoice: string }) =>
        credit.invoice === `${prefix}-CREDIT-OLD`);
      expect(overlappingCredits).toHaveLength(1);
      expect(overlappingCredits[0].importId).toBe(overlapCredit.id);
      const heldByOldCredit = (await call("/scanback/verify", creditSettings)).data;
      expect(heldByOldCredit.results[0].reason).toContain(`${prefix}-CREDIT-OLD`);
      const reviewedResolution = await call(`/scanback/pronto-credits/${overlapCredit.id}/2/resolve`, {
        mode: "reviewed", note: "Checked the archived return record.",
      });
      expect(reviewedResolution.status).toBe(200);
      expect(reviewedResolution.data).toMatchObject({
        sourceRow: 2, mode: "reviewed", note: "Checked the archived return record.", serials: [],
      });
      const afterReviewedResolution = (await call("/scanback/verify", creditSettings)).data;
      expect(afterReviewedResolution.results[0].reason).not.toContain("unmatched Pronto credit");
      let laterOverlap = await upload("auto", prontoHeader + creditPr("CREDIT-OLD", "", -1) +
        creditPr("CREDIT-LATER-SALE", "LATERUNIQUE", 1), "old-credit-later-overlap");
      laterOverlap = await remapPronto(laterOverlap);
      await commit(laterOverlap);
      const afterOverlapCredits = (await call("/upload-center")).data.unmatchedCredits;
      expect(afterOverlapCredits.some((credit: { invoice: string }) => credit.invoice === `${prefix}-CREDIT-OLD`)).toBe(false);
      expect((await call("/scanback/verify", creditSettings)).data.results[0].reason).not.toContain("unmatched Pronto credit");
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

      // Weekly claims are grouped by the customer's sold date. One customer
      // has an approved snapshot and another remains pending verification.
      const weeklySku = `CPWEEK${Date.now()}`;
      const weeklyCustomers = [a, other, accounts[2]].filter(Boolean);
      const weeklyProgram = (await call("/scanback/programs", {
        name: `${prefix} Weekly`, start: "2001-09-01", end: "2001-09-30", notes: "",
        customerIds: weeklyCustomers.map((customer: { id: number }) => customer.id),
        lines: [{
          sku: weeklySku, partId: null, gtmBuyCents: 7000,
          caps: weeklyCustomers.map((customer: { id: number }) => ({ resellerId: customer.id, quantity: null })),
        }],
      })).data;
      const weeklyEvidence = await commit(await upload("evidence",
        `${header}${prefix}-weekly-a,01/09/2001,${a.code},${weeklySku},1,${prefix}WKA,100.00,60.00\n` +
        `${prefix}-weekly-b,01/09/2001,${other.code},${weeklySku},1,${prefix}WKB,100.00,60.00\n`,
        "weekly-claims-evidence"));
      expect(weeklyEvidence.errors).toEqual([]);
      const weeklyClaimA = await commit(await upload("claim",
        `Serial,SKU,Sale Date,Account\n${prefix}WKA,${weeklySku},15/09/2001,${a.code}\n`, "weekly-claim-a"));
      const weeklyClaimB = await commit(await upload("claim",
        `Serial,SKU,Sale Date,Account\n${prefix}WKB,${weeklySku},16/09/2001,${other.code}\n`, "weekly-claim-b"));
      const weeklyDraftA = (await call("/scanback/verify", {
        programId: weeklyProgram.id, accountId: a.id, claimImportId: weeklyClaimA.id,
        basis: "sell", from: weeklyProgram.start, to: weeklyProgram.end,
      })).data;
      expect(weeklyDraftA.results[0]).toMatchObject({ status: "eligible", unitPriceCents: 10000, gtmBuyCents: 7000, amountCents: 3000 });
      const weeklyApproval = await call("/scanback/approve", {
        draftId: weeklyDraftA.id, token: weeklyDraftA.token, reference: `${prefix}-weekly-approved`,
      });
      expect(weeklyApproval.status).toBe(200);
      ids.batches.add(weeklyApproval.data.id);

      const weeklyParams = new URLSearchParams({ programId: weeklyProgram.id, week: "2001-W37" });
      const claimsByWeekResponse = await fetch(`${base}/scanback/claims-by-week?${weeklyParams}`, {
        headers: { Cookie: sessionCookie },
      });
      expect(claimsByWeekResponse.status).toBe(200);
      const weekly = await claimsByWeekResponse.json() as any;
      expect(weekly.weekLabel).toBe("w/e Sun 16 Sep");
      const summaryA = weekly.customers.find((customer: any) => customer.accountId === a.id);
      const summaryB = weekly.customers.find((customer: any) => customer.accountId === other.id);
      expect(summaryA).toMatchObject({
        reportedCount: 1, qualifyingCount: 1, notQualifyingCount: 0,
        qualifyingCents: 3000, approvedCents: 3000, awaitingApprovalCents: 0,
      });
      expect(summaryB).toMatchObject({
        reportedCount: 1, qualifyingCount: 1, notQualifyingCount: 0,
        qualifyingCents: 3000, approvedCents: 0, awaitingApprovalCents: 3000,
      });
      expect(summaryA.lines[0]).toMatchObject({
        serial: `${prefix}WKA`, status: "approved", invoiceNo: `${prefix}-weekly-a`,
        invoicedPriceCents: 10000, gtmBuyExCents: 7000, claimCents: 3000,
      });
      expect(summaryB.lines[0]).toMatchObject({
        serial: `${prefix}WKB`, status: "awaiting_approval",
        invoicedPriceCents: 10000, gtmBuyExCents: 7000, claimCents: 3000,
      });
      expect(weekly.totals).toMatchObject({
        reportedCount: 2, qualifyingCount: 2, notQualifyingCount: 0,
        qualifyingCents: 6000, approvedCents: 3000, awaitingApprovalCents: 3000,
      });
      const approvedFilters = new URLSearchParams({ programId: weeklyProgram.id, week: "2001-W37", status: "approved" });
      const approvedOnly = await (await fetch(`${base}/scanback/claims-by-week?${approvedFilters}`, {
        headers: { Cookie: sessionCookie },
      })).json() as any;
      expect(approvedOnly.customers).toHaveLength(1);
      expect(approvedOnly.customers[0]).toMatchObject({
        accountId: a.id, reportedCount: 1, qualifyingCount: 1, notQualifyingCount: 0,
        approvedCents: 3000, awaitingApprovalCents: 0,
      });
      expect(approvedOnly.totals).toMatchObject({ reportedCount: 1, qualifyingCents: 3000, approvedCents: 3000 });
      const pendingCustomerFilters = new URLSearchParams({
        programId: weeklyProgram.id, week: "2001-W37", customerId: String(other.id), status: "awaiting_approval",
      });
      const pendingOnly = await (await fetch(`${base}/scanback/claims-by-week?${pendingCustomerFilters}`, {
        headers: { Cookie: sessionCookie },
      })).json() as any;
      expect(pendingOnly.customers).toHaveLength(1);
      expect(pendingOnly.customers[0]).toMatchObject({
        accountId: other.id, reportedCount: 1, qualifyingCount: 1, approvedCents: 0, awaitingApprovalCents: 3000,
      });
      const allWeeksFilters = new URLSearchParams({ programId: weeklyProgram.id, week: "all" });
      const allWeeks = await (await fetch(`${base}/scanback/claims-by-week?${allWeeksFilters}`, {
        headers: { Cookie: sessionCookie },
      })).json() as any;
      expect(allWeeks).toMatchObject({ selectedWeek: null, weekLabel: "All weeks in promotion" });
      expect(allWeeks.totals).toMatchObject({ reportedCount: 2, qualifyingCents: 6000 });
      const defaultWeek = await (await fetch(`${base}/scanback/claims-by-week?programId=${weeklyProgram.id}`, {
        headers: { Cookie: sessionCookie },
      })).json() as any;
      expect(defaultWeek.selectedWeek).toBe(defaultWeek.defaultWeek);
      expect(defaultWeek.weekOptions.some((option: { weekIso: string }) => option.weekIso === defaultWeek.defaultWeek)).toBe(true);
      const noReportCustomer = weekly.customers.find((customer: any) =>
        ![a.id, other.id].includes(customer.accountId),
      );
      if (weeklyCustomers.length > 2) expect(noReportCustomer).toMatchObject({ hasSerialReport: false, reportedCount: 0 });

      const weeklyExport = await fetch(`${base}/scanback/claims-by-week/export?${weeklyParams}`, {
        headers: { Cookie: sessionCookie },
      });
      expect(weeklyExport.status).toBe(200);
      const weeklyWorkbook = XLSX.read(Buffer.from(await weeklyExport.arrayBuffer()), { type: "buffer" });
      expect(weeklyWorkbook.SheetNames.slice(0, 2)).toEqual(["Customer summary", "Serial details"]);
      expect(weeklyWorkbook.SheetNames).toContain(maskCustomerText(a.code));
      expect(weeklyWorkbook.SheetNames).toContain(maskCustomerText(other.code));
      const exportSummary = XLSX.utils.sheet_to_json<unknown[]>(weeklyWorkbook.Sheets["Customer summary"], { header: 1 });
      expect(exportSummary.slice(0, 3)).toEqual([
        ["Promotion", `${prefix} Weekly`],
        ["Promotion dates", "2001-09-01 to 2001-09-30"],
        ["Week", "w/e Sun 16 Sep"],
      ]);
      expect(exportSummary).toContainEqual([maskCustomerText(a.code), 1, 1, 0, 30, 30, 0]);
      expect(exportSummary).toContainEqual([maskCustomerText(other.code), 1, 1, 0, 30, 0, 30]);
      const exportLines = XLSX.utils.sheet_to_json<unknown[]>(weeklyWorkbook.Sheets["Serial details"], { header: 1 });
      const exportedWeeklyA = exportLines.find(row => row[0] === `${prefix}WKA`)!;
      const exportedWeeklyB = exportLines.find(row => row[0] === `${prefix}WKB`)!;
      expect(exportedWeeklyA[7]).toBe(30);
      expect(exportedWeeklyA[8]).toContain("Approved");
      expect(exportedWeeklyB[7]).toBe(30);
      expect(exportedWeeklyB[8]).toContain("awaiting approval");

      // Approved promotions are blocked with the exact archive instruction.
      const blockedDelete = await fetch(`${base}/scanback/programs/${weeklyProgram.id}`, {
        method: "DELETE", headers: { Cookie: sessionCookie },
      });
      expect(blockedDelete.status).toBe(409);
      expect(await blockedDelete.json()).toMatchObject({
        error: "This promotion has approved claims — archive it instead",
      });

      // A no-approval promotion and its unapproved draft can be deleted; the
      // deletion itself must leave a durable audit row.
      const deletable = (await call("/scanback/programs", {
        name: `${prefix} Deletable`, start: "2001-09-01", end: "2001-09-30", notes: "",
        customerIds: [a.id],
        lines: [{ sku: `CPDEL${Date.now()}`, partId: null, gtmBuyCents: 7000, caps: [{ resellerId: a.id, quantity: null }] }],
      })).data;
      const deletionDraft = (await call("/scanback/verify", {
        programId: deletable.id, accountId: a.id, claimImportId: weeklyClaimA.id,
        basis: "sell", from: deletable.start, to: deletable.end,
      })).data;
      ids.drafts.add(deletionDraft.id);
      const deleteResponse = await fetch(`${base}/scanback/programs/${deletable.id}`, {
        method: "DELETE", headers: { Cookie: sessionCookie },
      });
      expect(deleteResponse.status).toBe(200);
      const deleteResult = await deleteResponse.json() as { id: string; deletedDraftCount: number; auditId: number };
      expect(deleteResult).toMatchObject({ id: deletable.id, deletedDraftCount: 1 });
      ids.audits.add(deleteResult.auditId);
      const auditRow = await pool.query("SELECT action,entity_id,entity_name,details FROM scanback_audit_log WHERE id=$1", [deleteResult.auditId]);
      expect(auditRow.rows[0]).toMatchObject({
        action: "promotion_deleted", entity_id: deletable.id, entity_name: deletable.name,
        details: expect.objectContaining({ deletedDraftCount: 1 }),
      });
      expect((await pool.query("SELECT id FROM scanback_drafts WHERE id=$1", [deletionDraft.id])).rowCount).toBe(0);
      const afterDeleteWorkspace = (await call("/scanback/workspace")).data;
      expect(afterDeleteWorkspace.programs.some((program: { id: string }) => program.id === deletable.id)).toBe(false);

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
        await cleanup.query("DELETE FROM scanback_audit_log WHERE id=ANY($1::int[])", [[...ids.audits]]);
        await cleanup.query("COMMIT");
      } catch (e) { await cleanup.query("ROLLBACK"); throw e; }
      finally { cleanup.release(); }
    }
  }, 90_000);
});
