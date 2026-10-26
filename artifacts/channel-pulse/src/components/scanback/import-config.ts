import type { ScanbackImport } from "@workspace/api-client-react";

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

export const KIND_META: Record<ScanbackImport["kind"], { label: string; blurb: string; required: MappingKey[]; needsAccount: boolean }> = {
  evidence: {
    label: "Invoice / credit evidence",
    blurb: "Pronto invoice and credit extracts. Credits use negative quantity. Unit price is what the reseller was invoiced ex GST.",
    required: ["serial", "sku", "date", "invoice", "quantity", "unitPrice"],
    needsAccount: true,
  },
  claim: {
    label: "Customer claim / serial report",
    blurb: "One serial per row represents one unit. Sell-date basis needs a date column.",
    required: ["serial"],
    needsAccount: false,
  },
  history: {
    label: "Historical approved claims",
    blurb: "Earlier approved claims so the once-across-all-promotions rule includes them. Never becomes a new payable approval.",
    required: ["serial", "sku", "date", "amount", "program", "reference"],
    needsAccount: true,
  },
};

