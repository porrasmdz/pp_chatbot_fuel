import { existsSync } from "node:fs";
import { BackupRuntime } from "../dist/backup-runtime.js";
import { sheetConfigFromEnv } from "../dist/sheets.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const config = sheetConfigFromEnv();
if (!config) {
  console.error("Configura Google Sheets para reconciliar los respaldos pendientes.");
  process.exitCode = 1;
} else {
  try {
    const runtime = new BackupRuntime(config, process.env.APP_DATA_DIR || ".");
    await runtime.queue.init();
    const count = await runtime.queue.resetBlocked();
    console.log(`Trabajos bloqueados reactivados: ${count}`);
    await runtime.processPending();
  } catch (error) {
    console.error("No se pudieron reintentar los respaldos:", error instanceof Error ? error.message : "error desconocido");
    process.exitCode = 1;
  }
}
