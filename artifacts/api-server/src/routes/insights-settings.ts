import { Router, type IRouter } from "express";
import { db, insightSettings } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

const DEFAULTS = {
  woi_green_max: 8,
  woi_amber_max: 15,
  stockout_horizon_weeks: 3,
  overstock_woi_threshold: 15,
  overstock_min_soh: 20,
  spike_multiplier: 3.0,
  dead_stock_weeks: 4,
};

async function getOrCreateSettings() {
  const rows = await db.select().from(insightSettings).limit(1);
  if (rows.length > 0) return rows[0];
  const [created] = await db.insert(insightSettings).values({}).returning();
  return created;
}

function toResponse(s: typeof insightSettings.$inferSelect) {
  return {
    id: s.id,
    woi_green_max: s.woiGreenMax,
    woi_amber_max: s.woiAmberMax,
    stockout_horizon_weeks: s.stockoutHorizonWeeks,
    overstock_woi_threshold: s.overstockWoiThreshold,
    overstock_min_soh: s.overstockMinSoh,
    spike_multiplier: Number(s.spikeMultiplier),
    dead_stock_weeks: s.deadStockWeeks,
    updated_at: s.updatedAt?.toISOString(),
  };
}

router.get("/insights/settings", async (req, res) => {
  try {
    const s = await getOrCreateSettings();
    res.json(toResponse(s));
  } catch (err) {
    req.log.error({ err }, "Failed to get insight settings");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/insights/settings", async (req, res) => {
  try {
    const body = req.body as Partial<typeof DEFAULTS>;
    const updates: Record<string, unknown> = {};
    if (body.woi_green_max != null) updates.woiGreenMax = body.woi_green_max;
    if (body.woi_amber_max != null) updates.woiAmberMax = body.woi_amber_max;
    if (body.stockout_horizon_weeks != null) updates.stockoutHorizonWeeks = body.stockout_horizon_weeks;
    if (body.overstock_woi_threshold != null) updates.overstockWoiThreshold = body.overstock_woi_threshold;
    if (body.overstock_min_soh != null) updates.overstockMinSoh = body.overstock_min_soh;
    if (body.spike_multiplier != null) updates.spikeMultiplier = String(body.spike_multiplier);
    if (body.dead_stock_weeks != null) updates.deadStockWeeks = body.dead_stock_weeks;
    updates.updatedAt = new Date();

    const existing = await getOrCreateSettings();
    const [updated] = await db
      .update(insightSettings)
      .set(updates)
      .where(eq(insightSettings.id, existing.id))
      .returning();

    res.json(toResponse(updated));
  } catch (err) {
    req.log.error({ err }, "Failed to update insight settings");
    res.status(500).json({ error: "Internal server error" });
  }
});

export { getOrCreateSettings };
export default router;
