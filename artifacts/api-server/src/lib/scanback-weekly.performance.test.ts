import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import type { ScanbackImport, ScanbackProgram } from "@workspace/api-zod";
import {
  buildEvidenceSerialIndex,
  verifyClaim,
  type EvidenceRow,
} from "./scanback-engine";
import { buildInvoiceSkuIndex } from "./scanback-auto-drafts";
import { firstReportedSales, reportedSales } from "./serial-tracking";
import { buildScanbackClaimsByWeekFromContext } from "./scanback-weekly";
import { verifyWithContext, type ScanbackVerificationData } from "./scanback-store";

describe("weekly claims performance", () => {
  it("matches legacy verification results with 25k evidence rows and returns 30 reports under two seconds", () => {
    const customerIds = Array.from({ length: 9 }, (_, index) => index + 1);
    const sku = "WEEK-PERF-SKU";
    const program: ScanbackProgram = {
      id: "weekly-perf-promotion",
      version: 1,
      name: "Weekly performance fixture",
      start: "2026-09-01",
      end: "2026-09-30",
      notes: "",
      archived: false,
      createdAt: "2026-08-01T00:00:00.000Z",
      customerIds,
      lines: [{
        sku,
        partId: null,
        gtmBuyCents: 7000,
        caps: customerIds.map(resellerId => ({ resellerId, quantity: null })),
      }],
    };
    const accounts = customerIds.map(id => ({
      id, code: `C${id}`, name: `Customer ${id}`, active: true,
    }));
    const reports: ScanbackImport[] = Array.from({ length: 30 }, (_, index) => {
      const accountId = customerIds[index % customerIds.length];
      const serial = `WEEKPERF-${String(index).padStart(4, "0")}`;
      return {
        id: `weekly-perf-report-${index}`,
        kind: "claim",
        name: `report-${index}.csv`,
        state: "committed",
        createdAt: `2026-09-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        committedAt: `2026-09-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        headers: [], sheets: ["Claims"], mapping: {}, dateFormat: "dmy", sheet: "Claims",
        accountId,
        rows: [{
          rowIndex: 0, serial, sku, date: "2026-09-15", accountId, quantity: 1,
          invoice: "", unitPriceCents: null, costCents: null, amountCents: null,
          program: "", reference: "",
        }],
        errors: [], warnings: [], duplicate: false, recordCount: 1,
      };
    });
    const targetRows = new Map(reports.map(report => [report.rows[0].serial, report.rows[0]]));
    const prontoEvidence: EvidenceRow[] = Array.from({ length: 25_000 }, (_, index) => {
      const serial = targetRows.has(`WEEKPERF-${String(index).padStart(4, "0")}`)
        ? `WEEKPERF-${String(index).padStart(4, "0")}`
        : `PRONTO-PERF-${String(index).padStart(5, "0")}`;
      const reportIndex = Number(serial.slice("WEEKPERF-".length));
      const accountId = Number.isFinite(reportIndex) && targetRows.has(serial)
        ? reports[reportIndex].accountId!
        : customerIds[index % customerIds.length];
      return {
        rowIndex: index, sourceRow: index + 2, serial, sku, date: "2026-09-01",
        accountId, quantity: 1, invoice: `INV-${index}`, unitPriceCents: 10000,
        costCents: 6000, amountCents: null, program: "", reference: "",
        source: "Synthetic Pronto evidence",
      };
    });

    const started = performance.now();
    const sales = reportedSales(reports);
    const context: ScanbackVerificationData = {
      programs: [program],
      programsById: new Map([[program.id, program]]),
      imports: reports,
      importsById: new Map(reports.map(report => [report.id, report])),
      claimImports: reports,
      evidenceImports: [],
      batches: [],
      autoDrafts: [],
      draftsByAutoKey: new Map(),
      approvedDraftIds: new Set(),
      invoiceRows: prontoEvidence,
      invoiceSkuIndex: buildInvoiceSkuIndex(prontoEvidence),
      evidence: prontoEvidence,
      evidenceBySerial: buildEvidenceSerialIndex(prontoEvidence),
      approved: [],
      approvedBySerial: new Map(),
      parts: [],
      accounts,
      accountCodesById: new Map(accounts.map(account => [account.id, account.code])),
      restrictedSerials: new Set(),
      unmatchedProntoCredits: [],
      unmatchedProntoCreditsByAccountSku: new Map(),
      reportedSales: sales,
      reportedSalesBySerial: firstReportedSales(sales),
      ddRangeSkus: new Set([sku]),
      tokenImports: [],
    };
    const report = buildScanbackClaimsByWeekFromContext(
      context, program.id, "2026-W38", "2026-W38",
    );
    const elapsedMs = performance.now() - started;

    expect(report.customers).toHaveLength(9);
    expect(report.totals).toMatchObject({
      reportedCount: 30,
      qualifyingCount: 30,
      notQualifyingCount: 0,
      qualifyingCents: 90_000,
      awaitingApprovalCents: 90_000,
    });
    expect(elapsedMs).toBeLessThan(2_000);

    const firstReport = reports[0];
    const expectedLegacy = verifyClaim({
      program,
      settings: {
        programId: program.id, accountId: firstReport.accountId!, claimImportId: firstReport.id,
        basis: "sell", from: program.start, to: program.end,
      },
      claims: firstReport.rows,
      evidence: prontoEvidence,
      approved: [],
      parts: [],
      restrictedSerials: context.restrictedSerials,
      unmatchedProntoCredits: [],
      reportedSales: sales,
      accounts,
      ddRangeSkus: context.ddRangeSkus,
    });
    expect(report.customers.flatMap(customer => customer.lines)
      .find(line => line.serial === firstReport.rows[0].serial)).toMatchObject({
        serial: firstReport.rows[0].serial,
        status: "awaiting_approval",
        invoicedPriceCents: 10000,
        gtmBuyExCents: 7000,
        claimCents: 3000,
      });
    expect(verifyWithContext(context, {
      programId: program.id, accountId: firstReport.accountId!, claimImportId: firstReport.id,
      basis: "sell", from: program.start, to: program.end,
    }).results).toEqual(expectedLegacy);
  });
});
