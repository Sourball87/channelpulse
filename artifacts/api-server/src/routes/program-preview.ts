import { Router } from "express";
import { pool } from "@workspace/db";
import { PreviewProgramTableBody } from "@workspace/api-zod";
import { requireThat, ScanbackError } from "../lib/scanback-store";
import {
  readPastedProgram, previewProgramRows, mapProgramHeadings, applyProgramSuggestions, programFields, type ProgramAccount,
} from "../lib/program-table";
import { requestProgramMapping } from "../lib/upload-ai";
import { maskCustomerText } from "../lib/customer-display";
import type { Sheets } from "../lib/scanback-import";

const router = Router();
router.post("/scanback/programs/preview", async (req, res) => {
  try {
    const parsed = PreviewProgramTableBody.safeParse(req.body);
    requireThat(parsed.success, "Use valid pasted text or a program-table upload.");
    const input = parsed.data!;
    requireThat(Boolean(input.text) !== Boolean(input.uploadId), "Choose either pasted text or an uploaded program table.");
    const accounts = (await pool.query("SELECT id,name,code,aliases FROM resellers ORDER BY code")).rows as ProgramAccount[];
    let headers: string[], rows: Record<string, unknown>[], sourceName: string;
    let storedMapping: Record<string, string> = {};
    if (input.uploadId) {
      const stored = (await pool.query("SELECT payload,raw_sheets FROM center_uploads WHERE id=$1", [input.uploadId])).rows[0];
      requireThat(stored && stored.payload.kind === "program", "Choose a program-table file in Upload Center.", 404);
      rows = Object.values(stored.raw_sheets as Sheets)[0] ?? [];
      headers = Object.keys(rows[0] ?? {});
      sourceName = stored.payload.name;
      storedMapping = stored.payload.mapping ?? {};
    } else {
      try { ({ headers, rows } = readPastedProgram(input.text!)); }
      catch (e) { throw new ScanbackError(e instanceof Error ? e.message : "Could not parse the pasted table."); }
      sourceName = "Pasted program";
    }
    requireThat(rows.length <= 1000 && headers.length <= 150, "Limit programs to 1,000 SKU rows and 150 columns.");
    let mapping = input.mapping ?? mapProgramHeadings(headers, accounts);
    if (!input.mapping) {
      for (const key of programFields) {
        const heading = storedMapping[key === "t1ExCents" ? "t1BuyExCents" : key] ?? storedMapping[key];
        if (heading && headers.includes(heading)) mapping.fields[key] = heading;
      }
    }
    let preview = previewProgramRows(headers, rows, accounts, mapping, sourceName);
    const used = new Set([...Object.values(mapping.fields).filter(Boolean), ...Object.keys(mapping.customers), ...mapping.ignored]);
    const unresolvedHeadings = headers.filter(h => !used.has(h));
    // Explicit mappings are authoritative. The model sees no table rows or
    // financial values and cannot generate a price, cap or SKU value.
    if (!input.mapping && input.ai_assist !== false && unresolvedHeadings.length) {
      try {
        const suggestion = await requestProgramMapping({
          unresolvedHeadings, existingMappings: mapping,
          accounts: accounts.map(a => ({ id: a.id, code: a.code, names: [a.name, ...(a.aliases ?? []), maskCustomerText(a.name)] })),
        });
        const proposed = applyProgramSuggestions(mapping, headers, accounts, suggestion);
        const changed = JSON.stringify(proposed) !== JSON.stringify(mapping);
        mapping = proposed;
        preview = previewProgramRows(headers, rows, accounts, mapping, sourceName);
        preview.aiNote = changed ? "AI proposed mappings for unclear headings/customer names. Confirm every assignment before creating the draft; all values still come from the source."
          : "AI found no supported additional mapping. Resolve or explicitly ignore highlighted columns.";
      } catch {
        preview.aiNote = "AI mapping was unavailable. Nothing was saved or invented; use the mapping dropdowns.";
      }
    }
    return res.json(preview);
  } catch (e) {
    if (e instanceof ScanbackError) return res.status(e.status).json({ error: e.message });
    req.log.error({ err: e }, "Program-table preview failed");
    return res.status(500).json({ error: "Could not preview the program table. No promotion was saved." });
  }
});
export default router;
