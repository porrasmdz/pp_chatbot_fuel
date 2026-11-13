import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { google, type drive_v3 } from "googleapis";

export type BackupPhoto = { buffer: Buffer; mimeType: string };
export type BackupInput = {
  idRegistro: string;
  placa: string;
  empleado: string;
  fecha: string;
  hora: string;
  factura: BackupPhoto;
  kilometraje: BackupPhoto;
};
export type BackupFile = { id: string; nombre: string; url: string | null };
export type BackupResult = {
  exito: boolean;
  estado: "COMPLETO" | "PARCIAL" | "FALLIDO";
  idRegistro: string;
  carpeta: { id: string; nombre: string } | null;
  archivos: { factura: BackupFile | null; kilometraje: BackupFile | null };
  error?: string;
  reintentar?: boolean;
};

const FOLDER_MIME = "application/vnd.google-apps.folder";
const RECORD_PROPERTY = "globalCropsRecordId";
const ROLE_PROPERTY = "globalCropsPhotoRole";
type PhotoRole = "factura" | "kilometraje";

export function safeFolderName(placa: string, empleado: string): string {
  const normalizedPlate = placa.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9-]/g, "");
  const normalizedName = empleado.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9 -]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalizedPlate || !normalizedName) throw new Error("Placa o empleado inválido para la carpeta de Drive");
  return `${normalizedPlate}_${normalizedName}`;
}

export function filePrefix(fecha: string, hora: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !/^\d{2}:\d{2}:\d{2}$/.test(hora)) throw new Error("Fecha u hora de repostaje inválida");
  const [year, month, day] = fecha.split("-").map(Number);
  const [hour, minute, second] = hora.split(":").map(Number);
  const valid = new Date(Date.UTC(year, month - 1, day));
  if (valid.getUTCFullYear() !== year || valid.getUTCMonth() + 1 !== month || valid.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) {
    throw new Error("Fecha u hora de repostaje inválida");
  }
  return `${fecha}_${hora.replaceAll(":", "-")}`;
}

export async function jpegBytes(photo: BackupPhoto): Promise<Buffer> {
  if (!Buffer.isBuffer(photo.buffer) || !photo.buffer.length) throw new Error("La fotografía está vacía");
  const mime = photo.mimeType.split(";", 1)[0].toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime)) throw new Error(`Formato de fotografía no compatible: ${mime}`);
  const image = await loadImage(photo.buffer);
  if (!image.width || !image.height) throw new Error("No se pudo decodificar la fotografía");
  if (mime === "image/jpeg" && photo.buffer[0] === 0xff && photo.buffer[1] === 0xd8) return photo.buffer;
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, image.width, image.height);
  context.drawImage(image, 0, 0);
  return canvas.toBuffer("image/jpeg", 92);
}

function escapeQuery(value: string): string { return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'"); }
function fileResult(file: drive_v3.Schema$File): BackupFile {
  if (!file.id || !file.name) throw new Error("Drive no confirmó ID y nombre del archivo");
  return { id: file.id, nombre: file.name, url: file.webViewLink ?? null };
}
function retryable(error: unknown): boolean {
  const value = error as { response?: { status?: number }; code?: number | string };
  const status = Number(value.response?.status ?? value.code);
  return status === 429 || (status >= 500 && status <= 599) || ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"].includes(String(value.code));
}

export class DriveBackupService {
  constructor(private readonly drive: drive_v3.Drive, private readonly rootId: string,
    private readonly wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {
    if (!rootId) throw new Error("Falta GOOGLE_DRIVE_ROOT_FOLDER_ID");
  }

  static async fromEnv(): Promise<DriveBackupService> {
    const rootId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID?.trim();
    if (!rootId) throw new Error("Falta GOOGLE_DRIVE_ROOT_FOLDER_ID");
    const envId = process.env.GOOGLE_DRIVE_CLIENT_ID?.trim();
    const envSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET?.trim();
    let clientId = envId;
    let clientSecret = envSecret;
    if (!clientId && !clientSecret) {
      const raw = JSON.parse(await readFile("./keys/google-drive-oauth.json", "utf8")) as { web?: { client_id?: string; client_secret?: string } };
      clientId = raw.web?.client_id;
      clientSecret = raw.web?.client_secret;
    }
    if (!clientId || !clientSecret) throw new Error("Faltan las credenciales OAuth de Google Drive");
    const token = JSON.parse(await readFile(process.env.GOOGLE_DRIVE_TOKEN_PATH?.trim() || "./keys/google-drive-token.json", "utf8")) as { refresh_token?: string; client_id?: string; scope?: string };
    if (!token.refresh_token || (token.client_id && token.client_id !== clientId) || (token.scope && !token.scope.split(/\s+/).includes("https://www.googleapis.com/auth/drive.file"))) {
      throw new Error("Refresh token de Google Drive inválido o incompatible");
    }
    const auth = new google.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ refresh_token: token.refresh_token });
    return new DriveBackupService(google.drive({ version: "v3", auth }), rootId);
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await operation(); }
      catch (error) {
        if (attempt >= 3 || !retryable(error)) throw error;
        await this.wait(250 * 2 ** attempt);
      }
    }
  }

  private async findFolder(name: string): Promise<drive_v3.Schema$File | null> {
    const response = await this.withRetry(() => this.drive.files.list({
      q: `'${escapeQuery(this.rootId)}' in parents and name = '${escapeQuery(name)}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
      fields: "files(id,name,mimeType,parents),nextPageToken", pageSize: 1000,
    }));
    return response.data.files?.[0] ?? null;
  }

  private async ensureFolder(name: string): Promise<drive_v3.Schema$File> {
    let folder = await this.findFolder(name);
    if (!folder) {
      const created = await this.withRetry(async () => {
        const again = await this.findFolder(name);
        if (again) return { data: again };
        return this.drive.files.create({
          requestBody: { name, mimeType: FOLDER_MIME, parents: [this.rootId] }, fields: "id,name,mimeType,parents",
        });
      });
      folder = created.data;
    }
    if (!folder.id) throw new Error("Drive no devolvió el ID de la carpeta");
    const verified = await this.withRetry(() => this.drive.files.get({ fileId: folder.id!, fields: "id,name,mimeType,parents,trashed,capabilities(canAddChildren)" }));
    if (verified.data.name !== name || verified.data.mimeType !== FOLDER_MIME || verified.data.trashed || !verified.data.parents?.includes(this.rootId) || verified.data.capabilities?.canAddChildren !== true) {
      throw new Error("La carpeta de Drive no pertenece a la raíz autorizada o no permite subidas");
    }
    return verified.data;
  }

  private async existingPhoto(folderId: string, idRegistro: string, role: PhotoRole): Promise<drive_v3.Schema$File | null> {
    const response = await this.withRetry(() => this.drive.files.list({
      q: `'${escapeQuery(folderId)}' in parents and appProperties has { key='${RECORD_PROPERTY}' and value='${escapeQuery(idRegistro)}' } and trashed = false`,
      fields: "files(id,name,mimeType,parents,appProperties,webViewLink),nextPageToken", pageSize: 1000,
    }));
    const match = response.data.files?.find(file => file.appProperties?.[ROLE_PROPERTY] === role);
    if (!match?.id) return null;
    const verified = await this.withRetry(() => this.drive.files.get({ fileId: match.id!, fields: "id,name,mimeType,parents,appProperties,webViewLink" }));
    if (verified.data.mimeType !== "image/jpeg" || !verified.data.parents?.includes(folderId)
      || verified.data.appProperties?.[RECORD_PROPERTY] !== idRegistro || verified.data.appProperties?.[ROLE_PROPERTY] !== role) {
      throw new Error(`El archivo ${role} existente no coincide con los metadatos del repostaje`);
    }
    return verified.data;
  }

  private async choosePrefix(folderId: string, base: string, idRegistro: string): Promise<string> {
    const response = await this.withRetry(() => this.drive.files.list({
      q: `'${escapeQuery(folderId)}' in parents and (name = '${base}_factura.jpg' or name = '${base}_kilometraje.jpg') and trashed = false`,
      fields: "files(id,name,appProperties)", pageSize: 1000,
    }));
    const collision = response.data.files?.some(file => file.appProperties?.[RECORD_PROPERTY] !== idRegistro);
    return collision ? `${base}_${createHash("sha256").update(idRegistro).digest("hex").slice(0, 10)}` : base;
  }

  private async upload(folderId: string, idRegistro: string, role: PhotoRole, name: string, bytes: Buffer): Promise<BackupFile> {
    const existing = await this.existingPhoto(folderId, idRegistro, role);
    if (existing) return fileResult(existing);
    const created = await this.withRetry(async () => {
      const again = await this.existingPhoto(folderId, idRegistro, role);
      if (again) return again;
      const response = await this.drive.files.create({
        requestBody: { name, mimeType: "image/jpeg", parents: [folderId], appProperties: { [RECORD_PROPERTY]: idRegistro, [ROLE_PROPERTY]: role } },
        media: { mimeType: "image/jpeg", body: Readable.from([bytes]) },
        fields: "id,name,mimeType,parents,appProperties,webViewLink",
      });
      return response.data;
    });
    if (!created.id) throw new Error(`Drive no confirmó el ID de ${role}`);
    const verified = await this.withRetry(() => this.drive.files.get({ fileId: created.id!, fields: "id,name,mimeType,parents,appProperties,webViewLink" }));
    if (verified.data.mimeType !== "image/jpeg" || !verified.data.parents?.includes(folderId) || verified.data.appProperties?.[RECORD_PROPERTY] !== idRegistro || verified.data.appProperties?.[ROLE_PROPERTY] !== role) {
      throw new Error(`Drive no confirmó correctamente el archivo ${role}`);
    }
    return fileResult(verified.data);
  }

  async respaldarRepostaje(input: BackupInput): Promise<BackupResult> {
    if (!input.idRegistro || input.idRegistro.length > 120) throw new Error("idRegistro inválido");
    const name = safeFolderName(input.placa, input.empleado);
    const base = filePrefix(input.fecha, input.hora);
    const result: BackupResult = { exito: false, estado: "FALLIDO", idRegistro: input.idRegistro,
      carpeta: null, archivos: { factura: null, kilometraje: null } };
    try {
      const folder = await this.ensureFolder(name);
      result.carpeta = { id: folder.id!, nombre: name };
      const facturaExisting = await this.existingPhoto(folder.id!, input.idRegistro, "factura");
      const kilometrajeExisting = await this.existingPhoto(folder.id!, input.idRegistro, "kilometraje");
      const prior = facturaExisting ?? kilometrajeExisting;
      const prefix = prior?.name?.replace(/_(factura|kilometraje)\.jpg$/, "") ?? await this.choosePrefix(folder.id!, base, input.idRegistro);
      let failedTemporary = false;
      let failedPermanent = false;
      for (const role of ["factura", "kilometraje"] as const) {
        try {
          const existing = role === "factura" ? facturaExisting : kilometrajeExisting;
          const bytes = existing ? null : await jpegBytes(input[role]);
          result.archivos[role] = existing ? fileResult(existing) : await this.upload(folder.id!, input.idRegistro, role, `${prefix}_${role}.jpg`, bytes!);
        } catch (error) {
          result.error = error instanceof Error ? error.message : "Error desconocido de Drive";
          if (retryable(error)) failedTemporary = true;
          else failedPermanent = true;
        }
      }
      result.estado = result.archivos.factura && result.archivos.kilometraje ? "COMPLETO" : result.archivos.factura || result.archivos.kilometraje ? "PARCIAL" : "FALLIDO";
      result.exito = result.estado === "COMPLETO";
      if (result.exito) delete result.error;
      else result.reintentar = failedTemporary && !failedPermanent;
      return result;
    } catch (error) {
      result.error = error instanceof Error ? error.message : "Error desconocido de Drive";
      result.reintentar = retryable(error);
      return result;
    }
  }
}
