import { pgTable, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

// JSON documents retain the exact version of financial terms/evidence used by a
// decision. Approved serials are normalized separately for database uniqueness.
export const scanbackPrograms = pgTable("scanback_programs", {
  id: text("id").primaryKey(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export const scanbackImports = pgTable("scanback_imports", {
  id: text("id").primaryKey(),
  contentKey: text("content_key").notNull().unique(),
  rawSheets: jsonb("raw_sheets").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export const scanbackDrafts = pgTable("scanback_drafts", {
  id: text("id").primaryKey(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export const scanbackBatches = pgTable("scanback_batches", {
  id: text("id").primaryKey(),
  draftId: text("draft_id").unique(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export const scanbackApprovedSerials = pgTable("scanback_approved_serials", {
  serial: text("serial").primaryKey(),
  batchId: text("batch_id").notNull().references(() => scanbackBatches.id),
  programId: text("program_id"),
  accountId: integer("account_id").notNull().references(() => resellersRef()),
  partId: integer("part_id").notNull().references(() => partsRef()),
  amountCents: integer("amount_cents").notNull(),
});

// Imported late through the existing schema module; references resolve lazily.
import { resellers, parts } from "./index";
const resellersRef = () => resellers.id;
const partsRef = () => parts.id;

export const insertScanbackProgramSchema = createInsertSchema(scanbackPrograms);
export const insertScanbackImportSchema = createInsertSchema(scanbackImports);
export const insertScanbackDraftSchema = createInsertSchema(scanbackDrafts);
export const insertScanbackBatchSchema = createInsertSchema(scanbackBatches);
export const insertScanbackApprovedSerialSchema = createInsertSchema(scanbackApprovedSerials);
export type ScanbackProgramRecord = typeof scanbackPrograms.$inferSelect;
export type ScanbackImportRecord = typeof scanbackImports.$inferSelect;
export type ScanbackDraftRecord = typeof scanbackDrafts.$inferSelect;
export type ScanbackBatchRecord = typeof scanbackBatches.$inferSelect;
