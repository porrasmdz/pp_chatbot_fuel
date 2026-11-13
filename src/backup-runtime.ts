import type { SheetConfig } from "./sheets.js";
import { DriveBackupQueue, type StagedBackup } from "./drive-backup-queue.js";
import { DriveBackupService, type BackupPhoto, type BackupResult } from "./drive-backup-service.js";
import { lookupPerson, registeredSignatures } from "./personas.js";

export class BackupRuntime {
  readonly queue: DriveBackupQueue;
  private running = false;
  private service: DriveBackupService | null = null;

  constructor(private readonly sheetConfig: SheetConfig, dataDir: string) {
    this.queue = new DriveBackupQueue(dataDir);
  }

  async start(): Promise<void> {
    await this.queue.init();
    void this.processPending();
    const timer = setInterval(() => { void this.processPending(); }, 60_000);
    timer.unref();
  }

  async stage(input: {
    idRegistro: string; phone: string | null; jid: string; claimedPlate: string;
    fecha: string; hora: string; signature: string; factura: BackupPhoto; kilometraje: BackupPhoto;
  }): Promise<"COMPLETE" | "EXISTING" | "STAGED"> {
    return this.queue.stage(input);
  }

  async alreadyRegistered(id: string): Promise<boolean> {
    const job = await this.queue.get(id);
    if (job?.status === "READY" || await this.queue.isComplete(id)) return true;
    if (!job) return false;
    const signatures = await registeredSignatures(this.sheetConfig);
    await this.queue.recoverRegistered(signatures);
    return (await this.queue.get(id))?.status === "READY";
  }

  async markRegistered(id: string, range: string): Promise<void> {
    await this.queue.markReady(id, range);
    void this.processPending();
  }

  private async worker(input: StagedBackup): Promise<BackupResult> {
    const person = await lookupPerson(this.sheetConfig, input.job.phone, input.job.jid, input.job.claimedPlate);
    if (!person) throw new Error("No se encontró teléfono y placa del remitente en Personas; respaldo pendiente");
    this.service ??= await DriveBackupService.fromEnv();
    return this.service.respaldarRepostaje({
      idRegistro: input.job.idRegistro, placa: person.placa, empleado: person.empleado,
      fecha: input.job.fecha, hora: input.job.hora,
      factura: input.factura, kilometraje: input.kilometraje,
    });
  }

  async processPending(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (await this.queue.hasStaged()) {
        try {
          const signatures = await registeredSignatures(this.sheetConfig);
          await this.queue.recoverRegistered(signatures);
        } catch (error) {
          console.error("No se pudieron reconciliar los trabajos de Drive con Matriz:", error instanceof Error ? error.message : "error desconocido");
        }
      }
      const processed = await this.queue.runDue(input => this.worker(input));
      if (processed) console.log(`Cola de respaldos Drive: ${processed} trabajo(s) procesado(s).`);
    } catch (error) {
      console.error("No se pudo procesar la cola de respaldos Drive:", error instanceof Error ? error.message : "error desconocido");
    } finally { this.running = false; }
  }
}
