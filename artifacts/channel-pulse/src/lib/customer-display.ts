const aliases: Record<string, string> = {
  ca: "CA", centrecom: "CC", cc: "CC", scorptec: "SC", sc: "SC",
  ple: "PL", pl: "PL", pccg: "PC", pc: "PC", umart: "UM", um: "UM",
  ks: "KS", jw: "JW", digi: "DI", digidirect: "DI", di: "DI",
};

export function isMaskedCustomer(code: string): boolean {
  return Object.hasOwn(aliases, code.trim().toLowerCase());
}

/** Display an account code without changing the identifier used by API requests. */
export function customerLabel(code: string | number | undefined | null): string {
  const text = String(code ?? "");
  return aliases[text.trim().toLowerCase()] ?? text;
}

export function maskCustomerText(text: string): string {
  const names: [string, string][] = [
    ["KS Computer Technology", "KS"], ["KS Computer Tech", "KS"], ["Computer Alliance", "CA"],
    ["ComputerAlliance", "CA"], ["PLE Computers", "PL"], ["PC Case Gear", "PC"],
    ["PC Casegear", "PC"], ["JW Computers", "JW"], ["Centre Com", "CC"], ["Centrecom", "CC"],
    ["Scorptec", "SC"], ["PCCG", "PC"], ["Umart", "UM"], ["DigiDirect", "DI"], ["Digi", "DI"], ["PLE", "PL"],
  ];
  return names.reduce((value, [name, alias]) =>
    value.replace(new RegExp(`(?<![a-z0-9])${name.replace(/ +/g, "[\\s_-]*")}(?![a-z0-9])`, "gi"), alias), text);
}
