import { Router, type IRouter } from "express";
import { db, resellers } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  CreateResellerBody,
  UpdateResellerBody,
  UpdateResellerParams,
  DeleteResellerParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/resellers", async (req, res) => {
  try {
    const rows = await db.select().from(resellers).orderBy(resellers.name);
    res.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        code: r.code,
        aliases: r.aliases ?? [],
        filename_patterns: r.filenamePatterns ?? [],
        expected_weekly_files: r.expectedWeeklyFiles,
        active: r.active,
        sends_soh: r.sendsSoh,
        sends_serial_reports: r.sendsSerialReports,
      })),
    );
  } catch (err) {
    req.log.error({ err }, "Failed to get resellers");
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/resellers", async (req, res) => {
  const body = CreateResellerBody.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "Invalid input", details: body.error.issues });
  }
  const { name, code, aliases, filename_patterns, expected_weekly_files, sends_soh, sends_serial_reports } = body.data;
  try {
    const [row] = await db
      .insert(resellers)
      .values({
        name,
        code,
        aliases: (aliases ?? []) as string[],
        filenamePatterns: (filename_patterns ?? []) as string[],
        expectedWeeklyFiles: expected_weekly_files ?? 1,
        sendsSoh: sends_soh ?? true,
        sendsSerialReports: sends_serial_reports ?? false,
      })
      .returning();
    res.status(201).json({
      id: row.id,
      name: row.name,
      code: row.code,
      aliases: row.aliases ?? [],
      filename_patterns: row.filenamePatterns ?? [],
      expected_weekly_files: row.expectedWeeklyFiles,
      active: row.active,
      sends_soh: row.sendsSoh,
      sends_serial_reports: row.sendsSerialReports,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to create reseller");
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/resellers/:id", async (req, res) => {
  const params = UpdateResellerParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "Invalid id" });

  const body = UpdateResellerBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid input" });

  const { name, code, aliases, filename_patterns, expected_weekly_files, active, sends_soh, sends_serial_reports } = body.data;

  try {
    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name;
    if (code !== undefined) updates.code = code;
    if (aliases !== undefined) updates.aliases = aliases;
    if (filename_patterns !== undefined) updates.filenamePatterns = filename_patterns;
    if (expected_weekly_files !== undefined) updates.expectedWeeklyFiles = expected_weekly_files;
    if (active !== undefined) updates.active = active;
    if (sends_soh !== undefined) updates.sendsSoh = sends_soh;
    if (sends_serial_reports !== undefined) updates.sendsSerialReports = sends_serial_reports;

    const [row] = await db
      .update(resellers)
      .set(updates)
      .where(eq(resellers.id, params.data.id))
      .returning();

    if (!row) return res.status(404).json({ error: "Not found" });

    res.json({
      id: row.id,
      name: row.name,
      code: row.code,
      aliases: row.aliases ?? [],
      filename_patterns: row.filenamePatterns ?? [],
      expected_weekly_files: row.expectedWeeklyFiles,
      active: row.active,
      sends_soh: row.sendsSoh,
      sends_serial_reports: row.sendsSerialReports,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to update reseller");
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/resellers/:id", async (req, res) => {
  const params = DeleteResellerParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "Invalid id" });

  try {
    await db.delete(resellers).where(eq(resellers.id, params.data.id));
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete reseller");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
