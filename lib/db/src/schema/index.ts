import { pgTable, serial, text, integer, boolean, numeric, timestamp, jsonb, unique } from "drizzle-orm/pg-core";
export * from "./scanback";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const resellers = pgTable("resellers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  code: text("code").notNull().unique(),
  aliases: text("aliases").array().default([]).notNull(),
  filenamePatterns: text("filename_patterns").array().default([]).notNull(),
  expectedWeeklyFiles: integer("expected_weekly_files").default(1).notNull(),
  active: boolean("active").default(true).notNull(),
  sendsSoh: boolean("sends_soh").default(true).notNull(),
  sendsSerialReports: boolean("sends_serial_reports").default(false).notNull(),
});

// Parsed spreadsheet records only, never file bytes or base64.
export const centerUploads = pgTable("center_uploads", {
  id: text("id").primaryKey(),
  payload: jsonb("payload").notNull(),
  rawSheets: jsonb("raw_sheets").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export const priceList = pgTable("price_list", {
  sku: text("sku").primaryKey(),
  description: text("description").notNull(),
  rrpIncCents: integer("rrp_inc_cents").notNull(),
  ddCostExCents: integer("dd_cost_ex_cents").notNull(),
  t1BuyExCents: integer("t1_buy_ex_cents").notNull(),
  uploadId: text("upload_id").notNull().references(() => centerUploads.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const parts = pgTable("parts", {
  id: serial("id").primaryKey(),
  partNo: text("part_no").notNull().unique(),
  displayName: text("display_name"),
  category: text("category").notNull(),
  active: boolean("active").default(true).notNull(),
});

export const uploads = pgTable("uploads", {
  id: serial("id").primaryKey(),
  resellerId: integer("reseller_id").references(() => resellers.id),
  filename: text("filename").notNull(),
  fileHash: text("file_hash").notNull(),
  reportDate: text("report_date"),
  weekIso: text("week_iso"),
  uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
  status: text("status").notNull().default("pending"),
  parserUsed: text("parser_used"),
  confidence: numeric("confidence"),
  rowsParsed: integer("rows_parsed"),
  rowsFlagged: integer("rows_flagged"),
  rawHeaders: jsonb("raw_headers"),
  rawRows: jsonb("raw_rows"),
  detectedMappings: jsonb("detected_mappings"),
  recognition: jsonb("recognition"),
});

export const inventorySnapshots = pgTable(
  "inventory_snapshots",
  {
    id: serial("id").primaryKey(),
    uploadId: integer("upload_id").references(() => uploads.id, { onDelete: "cascade" }),
    resellerId: integer("reseller_id")
      .references(() => resellers.id)
      .notNull(),
    partId: integer("part_id")
      .references(() => parts.id)
      .notNull(),
    reportDate: text("report_date"),
    weekIso: text("week_iso").notNull(),
    soh: integer("soh").default(0).notNull(),
    sellThrough7d: integer("sell_through_7d").default(0).notNull(),
    soldMtd: integer("sold_mtd").default(0),
    onOrder: integer("on_order").default(0),
    avgCost: numeric("avg_cost"),
    sold14d: integer("sold_14d"),
    sold30d: integer("sold_30d"),
  },
  (table) => ({
    uniq: unique("inventory_snapshots_reseller_part_week").on(
      table.resellerId,
      table.partId,
      table.weekIso,
    ),
  }),
);

export const columnMappings = pgTable(
  "column_mappings",
  {
    id: serial("id").primaryKey(),
    resellerId: integer("reseller_id")
      .references(() => resellers.id)
      .notNull(),
    fingerprint: text("fingerprint").notNull(),
    mapping: jsonb("mapping").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    uniq: unique("column_mappings_reseller_fingerprint").on(
      table.resellerId,
      table.fingerprint,
    ),
  }),
);

export const resellerFormatAssociations = pgTable(
  "reseller_format_associations",
  {
    id: serial("id").primaryKey(),
    resellerId: integer("reseller_id")
      .references(() => resellers.id)
      .notNull(),
    fingerprint: text("fingerprint").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    uniq: unique("reseller_format_associations_reseller_fingerprint").on(
      table.resellerId,
      table.fingerprint,
    ),
  }),
);

export const insightSettings = pgTable("insight_settings", {
  id: serial("id").primaryKey(),
  woiGreenMax: integer("woi_green_max").default(8).notNull(),
  woiAmberMax: integer("woi_amber_max").default(15).notNull(),
  stockoutHorizonWeeks: integer("stockout_horizon_weeks").default(3).notNull(),
  overstockWoiThreshold: integer("overstock_woi_threshold").default(15).notNull(),
  overstockMinSoh: integer("overstock_min_soh").default(20).notNull(),
  spikeMultiplier: numeric("spike_multiplier").default("3.0").notNull(),
  deadStockWeeks: integer("dead_stock_weeks").default(4).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insightAnnotations = pgTable("insight_annotations", {
  id: serial("id").primaryKey(),
  annotationType: text("annotation_type").notNull(),
  resellerId: integer("reseller_id").references(() => resellers.id),
  partId: integer("part_id").references(() => parts.id),
  weekIso: text("week_iso"),
  note: text("note").notNull(),
  dismissed: boolean("dismissed").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Insert schemas
export const insertInsightSettingsSchema = createInsertSchema(insightSettings).omit({ id: true, updatedAt: true });
export const insertInsightAnnotationSchema = createInsertSchema(insightAnnotations).omit({ id: true, createdAt: true });
export const insertResellerSchema = createInsertSchema(resellers).omit({ id: true });
export const insertPartSchema = createInsertSchema(parts).omit({ id: true });
export const insertUploadSchema = createInsertSchema(uploads).omit({ id: true, uploadedAt: true });
export const insertSnapshotSchema = createInsertSchema(inventorySnapshots).omit({ id: true });
export const insertColumnMappingSchema = createInsertSchema(columnMappings).omit({ id: true, createdAt: true });

export type Reseller = typeof resellers.$inferSelect;
export type Part = typeof parts.$inferSelect;
export type Upload = typeof uploads.$inferSelect;
export type InventorySnapshot = typeof inventorySnapshots.$inferSelect;
export type ColumnMapping = typeof columnMappings.$inferSelect;
export type ResellerFormatAssociation = typeof resellerFormatAssociations.$inferSelect;
export type InsightSettings = typeof insightSettings.$inferSelect;
export type InsightAnnotation = typeof insightAnnotations.$inferSelect;
