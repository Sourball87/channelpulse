import { Router, type IRouter } from "express";
import { db, insightAnnotations, resellers, parts } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";

const router: IRouter = Router();

function toResponse(a: typeof insightAnnotations.$inferSelect & { reseller_name?: string | null; part_no?: string | null }) {
  return {
    id: a.id,
    annotation_type: a.annotationType,
    reseller_id: a.resellerId,
    reseller_name: (a as { reseller_name?: string | null }).reseller_name ?? null,
    part_id: a.partId,
    part_no: (a as { part_no?: string | null }).part_no ?? null,
    week_iso: a.weekIso,
    note: a.note,
    dismissed: a.dismissed,
    created_at: a.createdAt?.toISOString(),
  };
}

router.get("/insights/annotations", async (req, res) => {
  try {
    const { week_iso, dismissed } = req.query as Record<string, string>;
    let query = db
      .select({
        id: insightAnnotations.id,
        annotationType: insightAnnotations.annotationType,
        resellerId: insightAnnotations.resellerId,
        partId: insightAnnotations.partId,
        weekIso: insightAnnotations.weekIso,
        note: insightAnnotations.note,
        dismissed: insightAnnotations.dismissed,
        createdAt: insightAnnotations.createdAt,
        reseller_name: resellers.name,
        part_no: parts.partNo,
      })
      .from(insightAnnotations)
      .leftJoin(resellers, eq(insightAnnotations.resellerId, resellers.id))
      .leftJoin(parts, eq(insightAnnotations.partId, parts.id))
      .orderBy(desc(insightAnnotations.createdAt));

    const rows = await query;
    const filtered = rows
      .filter((r) => !week_iso || r.weekIso === week_iso)
      .filter((r) => dismissed === undefined || r.dismissed === (dismissed === "true"));

    res.json(
      filtered.map((r) => ({
        id: r.id,
        annotation_type: r.annotationType,
        reseller_id: r.resellerId,
        reseller_name: r.reseller_name,
        part_id: r.partId,
        part_no: r.part_no,
        week_iso: r.weekIso,
        note: r.note,
        dismissed: r.dismissed,
        created_at: r.createdAt?.toISOString(),
      })),
    );
  } catch (err) {
    req.log.error({ err }, "Failed to get annotations");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/insights/annotations", async (req, res) => {
  try {
    const { annotation_type, reseller_id, part_id, week_iso, note } = req.body as {
      annotation_type: string;
      reseller_id?: number;
      part_id?: number;
      week_iso?: string;
      note: string;
    };

    if (!annotation_type || !note) {
      return res.status(400).json({ error: "annotation_type and note are required" });
    }

    const [created] = await db
      .insert(insightAnnotations)
      .values({
        annotationType: annotation_type,
        resellerId: reseller_id ?? null,
        partId: part_id ?? null,
        weekIso: week_iso ?? null,
        note,
      })
      .returning();

    res.status(201).json({
      id: created.id,
      annotation_type: created.annotationType,
      reseller_id: created.resellerId,
      reseller_name: null,
      part_id: created.partId,
      part_no: null,
      week_iso: created.weekIso,
      note: created.note,
      dismissed: created.dismissed,
      created_at: created.createdAt?.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to create annotation");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/insights/annotations/:id/dismiss", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const [updated] = await db
      .update(insightAnnotations)
      .set({ dismissed: true })
      .where(eq(insightAnnotations.id, id))
      .returning();

    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json({ id: updated.id, dismissed: updated.dismissed });
  } catch (err) {
    req.log.error({ err }, "Failed to dismiss annotation");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/insights/annotations/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    await db.delete(insightAnnotations).where(eq(insightAnnotations.id, id));
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete annotation");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
