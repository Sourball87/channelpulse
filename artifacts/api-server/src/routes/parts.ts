import { Router, type IRouter } from "express";
import { db, parts } from "@workspace/db";
import { eq, and, isNull, or, sql } from "drizzle-orm";
import {
  CreatePartBody,
  UpdatePartBody,
  UpdatePartParams,
  GetPartsQueryParams,
} from "@workspace/api-zod";

function deriveCategory(partNo: string): string {
  const p = partNo.toUpperCase().trim();
  if (p.startsWith("MZ-")) return "SSD";
  if (p.startsWith("MU-") && !p.startsWith("MUF-")) return "SSD";
  if (p.startsWith("MUF-") || p.startsWith("MB-")) return "Flash Memory";
  if (["LS", "LU", "LC", "LF", "LH"].some(prefix => p.startsWith(prefix))) return "Monitor";
  if (p.startsWith("SM-")) return "Mobility";
  if (p.startsWith("HAJ") || p.startsWith("MJ-")) return "HDD & Memory";
  return "Uncategorized";
}

const router: IRouter = Router();

router.get("/parts", async (req, res) => {
  try {
    const query = GetPartsQueryParams.safeParse(req.query);
    const category = query.success ? query.data.category : undefined;
    const uncategorized = query.success ? query.data.uncategorized : undefined;

    let rows = await db.select().from(parts).orderBy(parts.category, parts.partNo);

    if (uncategorized) {
      rows = rows.filter((r) => r.category === "Uncategorized");
    } else if (category) {
      rows = rows.filter((r) => r.category === category);
    }

    res.json(
      rows.map((r) => ({
        id: r.id,
        part_no: r.partNo,
        display_name: r.displayName,
        category: r.category,
        active: r.active,
      })),
    );
  } catch (err) {
    req.log.error({ err }, "Failed to get parts");
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/parts", async (req, res) => {
  const body = CreatePartBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid input" });

  const { part_no, display_name, category } = body.data;
  const derivedCategory = category || deriveCategory(part_no);

  try {
    const [row] = await db
      .insert(parts)
      .values({ partNo: part_no, displayName: display_name ?? null, category: derivedCategory })
      .returning();
    res.status(201).json({
      id: row.id,
      part_no: row.partNo,
      display_name: row.displayName,
      category: row.category,
      active: row.active,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to create part");
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/parts/:id", async (req, res) => {
  const params = UpdatePartParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "Invalid id" });

  const body = UpdatePartBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid input" });

  try {
    const updates: Record<string, unknown> = {};
    if (body.data.display_name !== undefined) updates.displayName = body.data.display_name;
    if (body.data.category !== undefined) updates.category = body.data.category;
    if (body.data.active !== undefined) updates.active = body.data.active;

    const [row] = await db
      .update(parts)
      .set(updates)
      .where(eq(parts.id, params.data.id))
      .returning();

    if (!row) return res.status(404).json({ error: "Not found" });

    res.json({
      id: row.id,
      part_no: row.partNo,
      display_name: row.displayName,
      category: row.category,
      active: row.active,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to update part");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export { deriveCategory };
export default router;
