import type { Request, Response, NextFunction } from "express";

// Presentation only: canonical customer identities remain available to import matching.
const customerNames: [string, string][] = [
  ["KS Computer Technology", "KS"], ["KS Computer Tech", "KS"],
  ["Computer Alliance", "CA"], ["ComputerAlliance", "CA"],
  ["PLE Computers", "PL"], ["PC Case Gear", "PC"], ["PC Casegear", "PC"],
  ["JW Computers", "JW"], ["Centre Com", "CC"], ["Centrecom", "CC"],
  ["Scorptec", "SC"], ["PCCG", "PC"], ["Umart", "UM"],
  ["DigiDirect", "DI"], ["Digi", "DI"], ["PLE", "PL"],
];
const patterns = customerNames.map(([name, alias]) => ({
  pattern: new RegExp(`(?<![a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ +/g, "[\\s_-]*")}(?![a-z0-9])`, "gi"),
  alias,
}));
const codeLabels: Record<string, string> = {
  ca: "CA", centrecom: "CC", cc: "CC", scorptec: "SC", sc: "SC",
  ple: "PL", pl: "PL", pccg: "PC", pc: "PC", umart: "UM", um: "UM",
  ks: "KS", jw: "JW", digi: "DI", digidirect: "DI", di: "DI",
};

export function maskCustomerText(text: string): string {
  return patterns.reduce((value, { pattern, alias }) => value.replace(pattern, alias), text);
}

const sourceFields = new Set([
  "mapping", "headers", "raw_sheets", "rawHeaders", "rawRows", "raw_headers", "raw_rows",
  "aliases", "filename_patterns", "prontoAccounts",
]);
const identifierFields = new Set([
  "id", "code", "reseller_code", "accountCode", "sourceCode", "serial", "sku",
  "part_no", "partNo", "stockCode", "token", "invoice", "sheet", "sheets", "resellers",
]);

export function maskCustomerDisplay(value: unknown, field = ""): unknown {
  if (sourceFields.has(field)) return value;
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    return identifierFields.has(field) || /(?:Id|_id)$/.test(field) ? value : maskCustomerText(value);
  }
  if (Array.isArray(value)) return value.map(item => maskCustomerDisplay(item, field));
  if (value && typeof value === "object") {
    const customer = value as Record<string, unknown>;
    const label = typeof customer.code === "string" ? codeLabels[customer.code.toLowerCase()] : undefined;
    return Object.fromEntries(Object.entries(customer).map(([key, item]) =>
      [key, key === "name" && label ? label : maskCustomerDisplay(item, key)]));
  }
  return value;
}

export function maskCustomerResponses(_req: Request, res: Response, next: NextFunction): void {
  const json = res.json.bind(res);
  res.json = (body: unknown) => json(maskCustomerDisplay(body));
  next();
}
