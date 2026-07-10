import { Router, type IRouter } from "express";
import { db, columnMappings, resellers } from "@workspace/db";
import { eq } from "drizzle-orm";
import { DeleteColumnMappingParams } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/column-mappings", async (req, res) => {
  try {
    const rows = await db
      .select({
        id: columnMappings.id,
        reseller_id: columnMappings.resellerId,
        reseller_name: resellers.name,
        fingerprint: columnMappings.fingerprint,
        mapping: columnMappings.mapping,
        created_at: columnMappings.createdAt,
      })
      .from(columnMappings)
      .leftJoin(resellers, eq(columnMappings.resellerId, resellers.id))
      .orderBy(columnMappings.createdAt);

    res.json(
      rows.map((r) => ({
        id: r.id,
        reseller_id: r.reseller_id,
        reseller_name: r.reseller_name,
        fingerprint: r.fingerprint,
        mapping: r.mapping,
        created_at: r.created_at?.toISOString(),
      })),
    );
  } catch (err) {
    req.log.error({ err }, "Failed to get column mappings");
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/column-mappings/:id", async (req, res) => {
  const params = DeleteColumnMappingParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "Invalid id" });

  try {
    await db.delete(columnMappings).where(eq(columnMappings.id, params.data.id));
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete column mapping");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
