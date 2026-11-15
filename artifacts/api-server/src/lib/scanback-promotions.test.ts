import { beforeEach, describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import * as XLSX from "xlsx";
import type { ScanbackImport, ScanbackProgram } from "@workspace/api-zod";
import { buildEvidenceSerialIndex, type EvidenceRow } from "./scanback-engine";
import { buildInvoiceSkuIndex } from "./scanback-auto-drafts";
import { firstReportedSales, reportedSales } from "./serial-tracking";
import { loadVerificationContext, type Client, type ScanbackVerificationData } from "./scanback-store";
import {
  buildPromotionPartner, buildPromotionTally, closePromotionPartner,
  reconcilePromotionPartner, requireReconciliationAllowed, promotionWorkbook,
} from "./scanback-promotions";

vi.mock("./scanback-store", async importOriginal => ({
  ...await importOriginal<typeof import("./scanback-store")>(),
  loadVerificationContext: vi.fn(),
}));

function fixture(cap: number | null = null) {
  const program: ScanbackProgram = {
    id: "promo", name: "Promotion fixture", version: 1, createdAt: "", notes: "",
    start: "2026-09-01", end: "2026-09-30", archived: false, customerIds: [1],
    lines: [{ sku: "SSD", partId: null, gtmBuyCents: 7000, caps: [{ resellerId: 1, quantity: cap }] }],
  };
  const context: ScanbackVerificationData = {
    programs: [program], programsById: new Map([[program.id, program]]),
    imports: [], importsById: new Map(), claimImports: [], evidenceImports: [],
    batches: [], autoDrafts: [], draftsByAutoKey: new Map(), approvedDraftIds: new Set(),
    invoiceRows: [], invoiceSkuIndex: new Map(), evidence: [], evidenceBySerial: new Map(),
    approved: [], approvedBySerial: new Map(), parts: [],
    accounts: [{ id: 1, code: "KS", name: "KS", active: true }],
    accountCodesById: new Map([[1, "KS"]]), restrictedSerials: new Set(),
    unmatchedProntoCredits: [], unmatchedProntoCreditsByAccountSku: new Map(),
    reportedSales: [], reportedSalesBySerial: new Map(), ddRangeSkus: new Set(["SSD"]), tokenImports: [],
    reportWeeksByImportId: new Map(),
  };
  function addReport(id: string, date: string, serials: string[]) {
    const rows: ScanbackImport["rows"] = serials.map((serial, rowIndex) => ({
      rowIndex, sourceRow: rowIndex + 2, serial, sku: "SSD", date, accountId: 1, quantity: 1,
      invoice: "", unitPriceCents: null, costCents: null, amountCents: null, program: "", reference: "",
    }));
    const report: ScanbackImport = {
      id, kind: "claim", name: `${id}.csv`, state: "committed", createdAt: date, committedAt: date,
      headers: [], sheets: [], mapping: {}, dateFormat: "dmy", sheet: "", accountId: 1,
      rows, errors: [], warnings: [], duplicate: false, recordCount: rows.length,
    };
    context.claimImports.push(report);
    context.imports.push(report);
    context.importsById.set(id, report);
    context.reportedSales = reportedSales(context.claimImports);
    context.reportedSalesBySerial = firstReportedSales(context.reportedSales);
    for (const row of rows) if (!context.evidence.some(event => event.serial === row.serial)) {
      context.evidence.push({ ...row, date: "2026-08-01", invoice: `DD-${row.serial}`, unitPriceCents: 10000, source: "DD fixture" });
    }
    context.evidenceBySerial = buildEvidenceSerialIndex(context.evidence);
    context.invoiceSkuIndex = buildInvoiceSkuIndex(context.evidence);
    return report;
  }
  return { program, context, addReport };
}
function store(context: ScanbackVerificationData) {
  vi.mocked(loadVerificationContext).mockResolvedValue(context);
  const drafts = new Map<string, unknown>();
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith("SELECT payload FROM scanback_drafts"))
      return { rowCount: drafts.has(String(params[0])) ? 1 : 0, rows: drafts.has(String(params[0])) ? [{ payload: drafts.get(String(params[0])) }] : [] };
    if (sql.includes("INSERT INTO scanback_drafts")) drafts.set(String(params[0]), JSON.parse(String(params[1])));
    if (sql.includes("INSERT INTO scanback_batches")) context.batches.push(JSON.parse(String(params[2])));
    if (sql.includes("INSERT INTO scanback_approved_serials")) {
      const approved = { serial: String(params[0]), batchId: String(params[1]), programId: String(params[2]),
        accountId: Number(params[3]), partId: null, sku: String(params[5]) };
      context.approved.push(approved);
      context.approvedBySerial.set(approved.serial, approved);
    }
    return { rowCount: 1, rows: [] };
  });
  return { c: { query } as unknown as Client, query };
}
beforeEach(() => vi.clearAllMocks());

describe("promotion running tally", () => {
  it("updates after another weekly serial report is committed and totals equal the weekly breakdown", () => {
    const { context, addReport } = fixture();
    addReport("week1", "2026-09-02", ["A"]);
    expect(buildPromotionTally(context, "promo").totals.claimCents).toBe(3000);
    addReport("week2", "2026-09-09", ["B", "C"]);
    const report = buildPromotionTally(context, "promo");
    expect(report.totals).toEqual({ reported: 3, qualifying: 3, notQualifying: 0, claimCents: 9000 });
    const partner = report.partners[0];
    for (const key of ["reported", "qualifying", "notQualifying", "claimCents"] as const)
      expect(partner.weeks.reduce((sum, week) => sum + week[key], 0)).toBe(partner[key]);
  });
  it("applies the customer/SKU cap once across all weeks and files", () => {
    const { context, addReport } = fixture(2);
    addReport("week1", "2026-09-02", ["A", "B"]);
    addReport("week2", "2026-09-09", ["C", "D"]);
    const partner = buildPromotionPartner(context, "promo", 1);
    expect(partner.qualifying).toBe(2);
    expect(partner.claimCents).toBe(6000);
    expect(partner.lines[2].reason).toContain("cap reached");
    expect(partner.capUsed).toContain("2 / 2");
  });
  it("rejects duplicate serials across weeks rather than paying twice", () => {
    const { context, addReport } = fixture();
    addReport("week1", "2026-09-02", ["A"]);
    addReport("week2", "2026-09-09", ["A"]);
    const partner = buildPromotionPartner(context, "promo", 1);
    expect(partner.qualifying).toBe(1);
    expect(partner.lines[1]).toMatchObject({ include: false, trackingColor: "red" });
    expect(partner.lines[1].reason).toContain("Duplicate");
  });
  it("recalculates returns and credits from the current Dicker evidence", () => {
    const { context, addReport } = fixture();
    addReport("week1", "2026-09-02", ["A"]);
    expect(buildPromotionPartner(context, "promo", 1).qualifying).toBe(1);
    context.evidence.push({ ...context.evidence[0], date: "2026-10-01", quantity: -1 });
    context.evidenceBySerial = buildEvidenceSerialIndex(context.evidence);
    expect(buildPromotionPartner(context, "promo", 1).lines[0].reason).toContain("returned");
    expect(buildPromotionPartner(context, "promo", 1).qualifying).toBe(0);
  });
  it("requires exclusion notes, frees cap capacity and records the reason", () => {
    const { context, addReport } = fixture(1);
    addReport("week1", "2026-09-02", ["A"]);
    addReport("week2", "2026-09-09", ["B"]);
    const exclusions = [{ lineId: "week1:0", note: "Customer withdrew serial" }];
    const partner = buildPromotionPartner(context, "promo", 1, { exclusions });
    expect(partner.lines[0]).toMatchObject({ include: false, reason: "Excluded: Customer withdrew serial" });
    expect(partner.lines[1].include).toBe(true);
    expect(partner.qualifying).toBe(1);
    expect(() => buildPromotionPartner(context, "promo", 1, { exclusions: [{ lineId: "week1:0", note: " " }] })).toThrow("note");
  });
  it("flags completed missing weeks without labelling future weeks as missing", () => {
    const { context, addReport } = fixture();
    addReport("week1", "2026-09-02", ["A"]);
    const partner = buildPromotionPartner(context, "promo", 1, {}, "2026-09-15");
    expect(partner.weeksReported).toBe(1);
    expect(partner.weeksExpected).toBe(5);
    expect(partner.missingWeeks).toEqual(["2026-09-13"]);
    context.reportWeeksByImportId!.set("week1", "2026-W37");
    expect(buildPromotionPartner(context, "promo", 1, {}, "2026-09-15").missingWeeks).toEqual([]);
  });
  it("preserves cross-customer ownership and unmatched-credit blocks", () => {
    const { context, addReport } = fixture();
    addReport("week1", "2026-09-02", ["A"]);
    context.reportedSalesBySerial.set("A", { ...context.reportedSalesBySerial.get("A")!, reportId: "other-report", accountId: 2 });
    expect(buildPromotionPartner(context, "promo", 1).qualifying).toBe(0);
    context.reportedSalesBySerial.clear();
    const credit = { accountSkuKey: "1|SSD", invoice: "CREDIT", date: "2026-09-03" };
    context.unmatchedProntoCreditsByAccountSku.set(credit.accountSkuKey, credit);
    expect(buildPromotionPartner(context, "promo", 1).lines[0].reason).toContain("unmatched Pronto credit");
  });
  it("keeps the shared verifier fast with 25k evidence rows and 30 weekly reports", () => {
    const { context, addReport } = fixture();
    for (let index = 0; index < 30; index++) addReport(`report${index}`, `2026-09-${String(index + 1).padStart(2, "0")}`, [`SERIAL-${index}`]);
    const filler: EvidenceRow[] = Array.from({ length: 25_000 }, (_, index) => ({
      ...context.evidence[0], serial: `FILLER-${index}`, invoice: `DD-FILLER-${index}`,
    }));
    context.evidence.push(...filler);
    context.evidenceBySerial = buildEvidenceSerialIndex(context.evidence);
    const started = performance.now();
    expect(buildPromotionTally(context, "promo").totals.qualifying).toBe(30);
    expect(performance.now() - started).toBeLessThan(2000);
  });
  it("exports exact serials and SKU codes, marks provisional tallies and loads evidence once", async () => {
    const { context, addReport } = fixture();
    addReport("week1", "2026-09-02", ["PLE-001"]);
    store(context);
    const book = XLSX.read(await promotionWorkbook({} as Client, "promo"), { type: "buffer" });
    expect(vi.mocked(loadVerificationContext)).toHaveBeenCalledTimes(1);
    expect(book.SheetNames).toEqual(["Partner summary", "Weekly breakdown", "Serial details"]);
    const summary = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets["Partner summary"], { header: 1 });
    expect(summary[0]).toEqual(["Running tally — not final"]);
    const details = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets["Serial details"], { header: 1 });
    expect(details[2][1]).toBe("PLE-001");
    expect(details[2][2]).toBe("SSD");
    expect(details[2][7]).toBe(30);
  });
});

describe("partner reconciliation and closure", () => {
  it("blocks final reconciliation before and on the end date, but permits a noted early override", () => {
    const { program } = fixture();
    expect(() => requireReconciliationAllowed(program, {}, "2026-09-29")).toThrow("blocked");
    expect(() => requireReconciliationAllowed(program, {}, "2026-09-30")).toThrow("blocked");
    expect(() => requireReconciliationAllowed(program, { earlyNote: " " }, "2026-09-29")).toThrow("blocked");
    expect(() => requireReconciliationAllowed(program, { earlyNote: "Partner final report received" }, "2026-09-29")).not.toThrow();
    expect(() => requireReconciliationAllowed(program, {}, "2026-10-01")).not.toThrow();
  });
  it("creates one batch per partner and returns it on repeated closes, never repaying serials", async () => {
    const { context, addReport } = fixture();
    addReport("week1", "2026-09-02", ["A"]);
    addReport("week2", "2026-09-09", ["B"]);
    const { c, query } = store(context);
    const checked = await reconcilePromotionPartner(c, "promo", 1, {});
    const input = { token: checked.token, reference: "One promotion statement" };
    const first = await closePromotionPartner(c, "promo", 1, input);
    const second = await closePromotionPartner(c, "promo", 1, input);
    expect(second.id).toBe(first.id);
    expect(context.batches).toHaveLength(1);
    expect(context.approved).toHaveLength(2);
    expect(first.totalCents).toBe(6000);
    expect(query.mock.calls.filter(([sql]) => sql.includes("INSERT INTO scanback_batches"))).toHaveLength(1);
    expect(buildPromotionTally(context, "promo").status).toBe("reconciled");
  });
  it("rejects stale reconciliation if a weekly report or Dicker evidence changes", async () => {
    const { context, addReport } = fixture();
    addReport("week1", "2026-09-02", ["A"]);
    const { c } = store(context);
    let checked = await reconcilePromotionPartner(c, "promo", 1, {});
    addReport("week2", "2026-09-09", ["B"]);
    await expect(closePromotionPartner(c, "promo", 1, { token: checked.token, reference: "Stale" })).rejects.toThrow("changed");
    checked = await reconcilePromotionPartner(c, "promo", 1, {});
    context.evidence[0].unitPriceCents = 11000;
    await expect(closePromotionPartner(c, "promo", 1, { token: checked.token, reference: "Stale" })).rejects.toThrow("changed");
    expect(context.batches).toHaveLength(0);
  });
  it("can close a zero-qualifying partner and retains all exclusion notes in its audit", async () => {
    const { context, addReport } = fixture();
    addReport("week1", "2026-09-02", ["A"]);
    const { c, query } = store(context);
    const checked = await reconcilePromotionPartner(c, "promo", 1, { exclusions: [{ lineId: "week1:0", note: "Withdrawn" }] });
    const batch = await closePromotionPartner(c, "promo", 1, { token: checked.token, reference: "Zero closure" });
    expect(batch.totalCents).toBe(0);
    expect(batch.approvedCount).toBe(0);
    expect(buildPromotionTally(context, "promo").status).toBe("reconciled");
    const audit = query.mock.calls.find(([sql]) => sql.includes("INSERT INTO scanback_audit_log"));
    expect(JSON.parse(String(audit![1]![2])).exclusions[0].note).toBe("Withdrawn");
  });
  it("shows old approved batches under the promotion and counts them against remaining caps without repaying", async () => {
    const { context, addReport } = fixture(2);
    addReport("week1", "2026-09-02", ["A"]);
    addReport("week2", "2026-09-09", ["B", "C"]);
    const oldRow = buildPromotionPartner(context, "promo", 1).lines[0];
    context.batches.push({ id: "old", reference: "Prior approval", accountCode: "KS",
      programName: "Promotion fixture", settings: { programId: "promo", accountId: 1, claimImportId: "week1" },
      createdAt: "", totalCents: 3000, approvedCount: 1, historical: false,
      basis: "sell", from: "2026-09-01", to: "2026-09-30", rows: [oldRow] });
    const approval = { serial: "A", batchId: "old", programId: "promo", accountId: 1, partId: null, sku: "SSD" };
    context.approved.push(approval);
    context.approvedBySerial.set("A", approval);
    const partner = buildPromotionPartner(context, "promo", 1);
    expect(partner.closed).toBe(false);
    expect(partner.qualifying).toBe(2);
    expect(partner.claimCents).toBe(6000);
    expect(partner.batches[0].reference).toBe("Prior approval");
    const { c } = store(context);
    const checked = await reconcilePromotionPartner(c, "promo", 1, {});
    const batch = await closePromotionPartner(c, "promo", 1, { token: checked.token, reference: "Remaining only" });
    expect(batch.totalCents).toBe(3000);
    expect(batch.approvedCount).toBe(1);
    expect(context.approved).toHaveLength(2);
  });
});
