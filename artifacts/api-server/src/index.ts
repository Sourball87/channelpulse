import app from "./app";
import { logger } from "./lib/logger";
import { ensureWeeklyScanbackExport } from "./lib/scanback-export-storage";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  const runWeeklyExport = () => {
    void ensureWeeklyScanbackExport().catch(err =>
      logger.error({ err }, "Weekly scanback export failed; it will retry later"));
  };
  runWeeklyExport();
  const weeklyExportCheck = setInterval(runWeeklyExport, 6 * 60 * 60 * 1000);
  weeklyExportCheck.unref();
});
