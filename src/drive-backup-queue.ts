import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BackupPhoto, BackupResult } from "./drive-backup-service.js";
import { normalizeDate, normalizeTime } from "./alertas-rules.js";

export type BackupJob = {
  idRegistro: string;
  phone: string | null;
  jid: string;
  claimedPlate: string;
  fecha: string;
  hora: string;
  signature: string;
  facturaMime: string;
  kilometrajeMime: string;
  status: "STAGED" | "READY" | "BLOCKED";
  attempts: number;
  nextAttemptAt: number;
  sheetRange?: string;
  lastError?: string;
};

export type StagedBackup = { job: BackupJob; factura: BackupPhoto; kilometraje: BackupPhoto };
type StageInput = Omit<BackupJob, "status" | "attempts" | "nextAttemptAt" | "facturaMime" | "kilometrajeMime"> & {
  factura: BackupPhoto; kilometraje: BackupPhoto;
};

export function stableRecordId(jid: string, dashboardId: string, invoiceId: string, plate: string, fecha: string, hora: string): string {
  if (!jid || !dashboardId || !invoiceId) throw new Error("Faltan IDs de mensajes para el respaldo");
  const hash = createHash("sha256").update(JSON.stringify([jid, dashboardId, invoiceId])).digest("hex").slice(0, 20);
  const safePlate = plate.toUpperCase().replace(/[^A-Z0-9-]/g, "");
  return `${safePlate}_${fecha}_${hora.replaceAll(":", "-")}_${hash}`;
}

function normalized(value: unknown): string { return String(value ?? "").trim().toUpperCase(); }
export function registrationSignature(row: Array<unknown>): string {
  return JSON.stringify([normalized(row[0]), normalized(row[1]), normalizeDate(row[3] as string | number) ?? normalized(row[3]), normalizeTime(row[4] as string | number) ?? normalized(row[4]).slice(0, 5),
    normalized(row[8]), normalized(row[9]).replace(/[^A-Z0-9]/g, ""), normalized(row[12])]);
}

async function atomicJson(path: string, value: object): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export class DriveBackupQueue {
  private readonly pendingDir: string;
  private readonly completeDir: string;
  private readonly active = new Set<string>();

  constructor(dataDir: string) {
    this.pendingDir = join(dataDir, "drive_backups", "pending");
    this.completeDir = join(dataDir, "drive_backups", "complete");
  }

  async init(): Promise<void> {
    await mkdir(this.pendingDir, { recursive: true, mode: 0o700 });
    await mkdir(this.completeDir, { recursive: true, mode: 0o700 });
  }

  private key(id: string): string { return createHash("sha256").update(id).digest("hex"); }
  private pendingPath(id: string): string { return join(this.pendingDir, this.key(id)); }
  private receiptPath(id: string): string { return join(this.completeDir, `${this.key(id)}.json`); }

  async isComplete(id: string): Promise<boolean> {
    try { await stat(this.receiptPath(id)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }

  async get(id: string): Promise<BackupJob | null> {
    try { return JSON.parse(await readFile(join(this.pendingPath(id), "job.json"), "utf8")) as BackupJob; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  async stage(input: StageInput): Promise<"COMPLETE" | "EXISTING" | "STAGED"> {
    await this.init();
    if (await this.isComplete(input.idRegistro)) return "COMPLETE";
    if (await this.get(input.idRegistro)) return "EXISTING";
    const job: BackupJob = {
      idRegistro: input.idRegistro, phone: input.phone, jid: input.jid,
      claimedPlate: input.claimedPlate, fecha: input.fecha, hora: input.hora,
      signature: input.signature, facturaMime: input.factura.mimeType, kilometrajeMime: input.kilometraje.mimeType,
      status: "STAGED", attempts: 0, nextAttemptAt: 0,
    };
    const temporary = join(this.pendingDir, `.tmp-${this.key(input.idRegistro)}-${randomBytes(4).toString("hex")}`);
    await mkdir(temporary, { mode: 0o700 });
    try {
      await writeFile(join(temporary, "factura.bin"), input.factura.buffer, { mode: 0o600 });
      await writeFile(join(temporary, "kilometraje.bin"), input.kilometraje.buffer, { mode: 0o600 });
      await writeFile(join(temporary, "job.json"), JSON.stringify(job), { mode: 0o600 });
      await rename(temporary, this.pendingPath(input.idRegistro));
      return "STAGED";
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
      if (await this.get(input.idRegistro)) return "EXISTING";
      throw error;
    }
  }

  async markReady(id: string, sheetRange?: string): Promise<void> {
    const job = await this.get(id);
    if (!job) { if (await this.isComplete(id)) return; throw new Error("No se encontró el trabajo persistido de Drive"); }
    if (job.status === "READY") return;
    await atomicJson(join(this.pendingPath(id), "job.json"), { ...job, status: "READY", sheetRange });
  }

  async recoverRegistered(signatures: Set<string>): Promise<number> {
    let count = 0;
    for (const entry of await readdir(this.pendingDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".tmp-")) continue;
      const job = JSON.parse(await readFile(join(this.pendingDir, entry.name, "job.json"), "utf8")) as BackupJob;
      if (job.status === "STAGED" && signatures.has(job.signature)) { await this.markReady(job.idRegistro); count++; }
    }
    return count;
  }

  async hasStaged(): Promise<boolean> {
    for (const entry of await readdir(this.pendingDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".tmp-")) continue;
      const job = JSON.parse(await readFile(join(this.pendingDir, entry.name, "job.json"), "utf8")) as BackupJob;
      if (job.status === "STAGED") return true;
    }
    return false;
  }

  async resetBlocked(): Promise<number> {
    let count = 0;
    for (const entry of await readdir(this.pendingDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".tmp-")) continue;
      const path = join(this.pendingDir, entry.name, "job.json");
      const job = JSON.parse(await readFile(path, "utf8")) as BackupJob;
      if (job.status !== "BLOCKED") continue;
      await atomicJson(path, { ...job, status: "READY", nextAttemptAt: 0, lastError: undefined });
      count++;
    }
    return count;
  }

  async runDue(worker: (input: StagedBackup) => Promise<BackupResult>, now = Date.now()): Promise<number> {
    let processed = 0;
    for (const entry of await readdir(this.pendingDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".tmp-") || this.active.has(entry.name)) continue;
      const path = join(this.pendingDir, entry.name);
      const job = JSON.parse(await readFile(join(path, "job.json"), "utf8")) as BackupJob;
      if (job.status !== "READY" || job.nextAttemptAt > now) continue;
      this.active.add(entry.name);
      try {
        const input: StagedBackup = { job,
          factura: { buffer: await readFile(join(path, "factura.bin")), mimeType: job.facturaMime },
          kilometraje: { buffer: await readFile(join(path, "kilometraje.bin")), mimeType: job.kilometrajeMime },
        };
        let result: BackupResult;
        try { result = await worker(input); }
        catch (error) { result = { exito: false, estado: "FALLIDO", idRegistro: job.idRegistro, carpeta: null,
          archivos: { factura: null, kilometraje: null }, error: error instanceof Error ? error.message : "Error desconocido",
          reintentar: /No se encontró teléfono y placa/.test(error instanceof Error ? error.message : "")
            || [429, 500, 502, 503, 504].includes(Number((error as { response?: { status?: number }; code?: number }).response?.status ?? (error as { code?: number }).code))
            || ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"].includes(String((error as { code?: string }).code)) }; }
        if (result.estado === "COMPLETO" && result.exito) {
          await atomicJson(this.receiptPath(job.idRegistro), { idRegistro: job.idRegistro, archivos: result.archivos, completedAt: new Date().toISOString() });
          await rm(path, { recursive: true, force: true });
        } else {
          const attempts = job.attempts + 1;
          await atomicJson(join(path, "job.json"), { ...job, attempts, status: result.reintentar === false ? "BLOCKED" : "READY",
            nextAttemptAt: now + Math.min(60 * 60_000, 5_000 * 2 ** Math.min(attempts - 1, 10)),
            lastError: result.error || result.estado });
        }
        processed++;
      } finally { this.active.delete(entry.name); }
    }
    return processed;
  }
}
