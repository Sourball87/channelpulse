import { Storage } from "@google-cloud/storage";
import { logger } from "./logger";
import { transaction } from "./scanback-store";
import { buildScanbackWorkbook, XLSX_MIME } from "./scanback-export";

const SIDECAR = "http://127.0.0.1:1106";
const storage = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${SIDECAR}/token`,
    type: "external_account",
    credential_source: {
      url: `${SIDECAR}/credential`,
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});
const objectNamePattern = /^scanback-weekly-\d{4}-W\d{2}\.xlsx$/;
const keepCount = 12;

export interface WeeklyExportEntry {
  name: string;
  createdAt: string;
  size: number;
}
export function weeklyExportName(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const day = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const year = day.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((day.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `scanback-weekly-${year}-W${String(week).padStart(2, "0")}.xlsx`;
}
export function expiredWeeklyExports(entries: WeeklyExportEntry[], keep = keepCount) {
  return [...entries]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name))
    .slice(Math.max(0, keep));
}

function storageLocation() {
  const privateDir = process.env.PRIVATE_OBJECT_DIR ?? "";
  const segments = privateDir.split("/").filter(Boolean);
  const bucketName = segments.shift();
  if (!bucketName) throw new Error("Private App Storage is not configured.");
  const prefix = [...segments, "channel-pulse", "scanback-weekly"].join("/");
  return { bucket: storage.bucket(bucketName), prefix };
}
function requireValidName(name: string) {
  if (!objectNamePattern.test(name)) throw new Error("Invalid weekly export name.");
}
export async function listWeeklyExports(): Promise<WeeklyExportEntry[]> {
  const { bucket, prefix } = storageLocation();
  const [files] = await bucket.getFiles({ prefix: `${prefix}/` });
  return files.flatMap(file => {
    const name = file.name.split("/").at(-1) ?? "";
    if (!objectNamePattern.test(name)) return [];
    const createdAt = String(file.metadata.timeCreated ?? "");
    return [{ name, createdAt, size: Number(file.metadata.size ?? 0) }];
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
}
export async function readWeeklyExport(name: string): Promise<Buffer> {
  requireValidName(name);
  const { bucket, prefix } = storageLocation();
  const [buffer] = await bucket.file(`${prefix}/${name}`).download();
  return buffer;
}
async function saveWeeklyExport(name: string, buffer: Buffer) {
  requireValidName(name);
  const { bucket, prefix } = storageLocation();
  await bucket.file(`${prefix}/${name}`).save(buffer, {
    resumable: false,
    metadata: { contentType: XLSX_MIME, cacheControl: "private, max-age=0, no-store" },
  });
}
async function pruneWeeklyExports(): Promise<number> {
  const expired = expiredWeeklyExports(await listWeeklyExports());
  if (!expired.length) return 0;
  const { bucket, prefix } = storageLocation();
  await Promise.all(expired.map(item => bucket.file(`${prefix}/${item.name}`).delete({ ignoreNotFound: true })));
  return expired.length;
}

/** Idempotent per ISO week so server restarts and multiple instances don't add duplicates. */
export async function ensureWeeklyScanbackExport(): Promise<void> {
  const name = weeklyExportName();
  const current = await listWeeklyExports();
  if (!current.some(item => item.name === name)) {
    const buffer = await transaction(buildScanbackWorkbook);
    await saveWeeklyExport(name, buffer);
    logger.info({ name, size: buffer.length }, "Saved weekly scanback export");
  }
  const pruned = await pruneWeeklyExports();
  if (pruned) logger.info({ pruned }, "Pruned old weekly scanback exports");
}
