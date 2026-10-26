import type { ScanbackUploadKind } from "@workspace/api-client-react";

export const MAPPING_KEYS = ["serial", "sku", "date", "account", "quantity", "invoice", "unitPrice", "amount", "program", "reference"] as const;
export type MappingKey = (typeof MAPPING_KEYS)[number];

export const FIELD_LABEL: Record<MappingKey, string> = {
  serial: "Serial number",
  sku: "SKU / part number",
  date: "Date",
  account: "Account / customer",
  quantity: "Quantity (signed)",
  invoice: "Invoice / credit reference",
  unitPrice: "Invoiced reseller unit price EX GST (not purchase cost)",
  amount: "Approved claim amount",
  program: "Promotion name",
  reference: "Claim reference",
};

export const KIND_META: Record<ScanbackUploadKind, { label: string; blurb: string; required: MappingKey[]; needsAccount: boolean; template: string[][] }> = {
  evidence: {
    label: "Invoice / credit evidence",
    blurb: "Pronto invoice and credit extracts. Credits use negative quantity. Unit price is what the reseller was invoiced ex GST.",
    required: ["serial", "sku", "date", "invoice", "quantity", "unitPrice"],
    needsAccount: true,
    template: [
      ["Invoice", "Invoice Date", "Account", "SKU", "Quantity", "Serials", "Invoiced Unit Price Ex GST"],
      ["INV-204118", "03/02/2025", "ACC001", "PART-123", "2", "SN0001; SN0002", "412.50"],
      ["CR-88013", "17/02/2025", "ACC001", "PART-123", "-1", "SN0002", "412.50"],
    ],
  },
  claim: {
    label: "Customer claim / serial report",
    blurb: "One serial per row represents one unit. Sell-date basis needs a date column.",
    required: ["serial"],
    needsAccount: false,
    template: [
      ["Serial", "SKU", "Sale Date", "Quantity"],
      ["SN0001", "PART-123", "11/02/2025", "1"],
    ],
  },
  history: {
    label: "Historical approved claims",
    blurb: "Earlier approved claims so the once-across-all-promotions rule includes them. Never becomes a new payable approval.",
    required: ["serial", "sku", "date", "amount", "program", "reference"],
    needsAccount: true,
    template: [
      ["Serial", "SKU", "Date", "Account", "Amount", "Promotion", "Claim Reference"],
      ["SN0450", "PART-123", "14/08/2024", "ACC001", "37.25", "Winter 2024 Scanback", "SB-2024-017"],
    ],
  },
};

export function templateHref(kind: ScanbackUploadKind): string {
  const csv = KIND_META[kind].template
    .map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","))
    .join("\r\n");
  return `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
}
