import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  extractMessageContent,
  jidDecode,
  useMultiFileAuthState,
  type WAMessage,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { analyzeImage, type DashboardReading } from "./analyze.js";
import { BackupRuntime } from "./backup-runtime.js";
import { applyClarification, fieldsToClarify } from "./clarification.js";
import { registrationSignature, stableRecordId } from "./drive-backup-queue.js";
import { analyzeInvoice, camposFacturaFaltantes, facturaLegible, type InvoiceReading } from "./invoice.js";
import { RateLimiter } from "./rate-limit.js";
import { appendPhotoWarning, appendReading, photoWarningRow, readingRow, sheetConfigFromEnv } from "./sheets.js";
import { contenidoInvalido, lecturaConfiable, limiteAlcanzado, mensajeRegistroExitoso, pedirFactura, pedirKilometraje, primeraFotoRecibida, sesionExpirada } from "./templates.js";
import { dashboardIssues, invoiceIssues, validationMessage } from "./validation.js";

const SESSION_DIR = join(process.env.APP_DATA_DIR || ".", "auth_info_baileys");
const SESSION_WINDOW_MS = 5 * 60_000;
const PHOTO_BATCH_MS = 5_000;
const CLARIFICATION_WINDOW_MS = 60_000;
const seen = new Set<string>();

type IncomingImage = { id: string; mime: string; numeroUsuario: string | null; remitenteJid: string };
type QueuedPhoto = { message: WAMessage; image: IncomingImage; receivedAt: number };
type SessionPhoto = { image: IncomingImage; receivedAt: number; bytes: Buffer };
type PendingSession = {
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  batchTimer?: ReturnType<typeof setTimeout>;
  photos: QueuedPhoto[];
  phone: string | null;
  reading?: DashboardReading;
  invoice?: InvoiceReading;
  dashboardPhoto?: SessionPhoto;
  invoicePhoto?: SessionPhoto;
  awaitingClarification?: { fields: string[]; deadline: number };
  dashboardMessageId?: string;
  invoiceMessageId?: string;
  lastValidSentAt?: Date;
};

export function incomingImage(message: WAMessage): IncomingImage | null {
  const sender = incomingSender(message);
  if (!sender) return null;
  const image = extractMessageContent(message.message)?.imageMessage;
  if (!image) return null;
  return { ...sender, mime: image.mimetype || "image/jpeg" };
}

export function incomingText(message: WAMessage): string | null {
  const content = extractMessageContent(message.message);
  return content?.conversation ?? content?.extendedTextMessage?.text ?? null;
}

export function whatsappSentAt(message: WAMessage): Date | null {
  const raw = message.messageTimestamp;
  const seconds = typeof raw === "number" ? raw : raw ? Number(raw.toString()) : NaN;
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function incomingSender(message: WAMessage): Omit<IncomingImage, "mime"> | null {
  const jid = message.key.remoteJid;
  if (message.key.fromMe || !jid || !(jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid")) || !message.key.id) return null;
  const alternate = (message.key as typeof message.key & { remoteJidAlt?: string }).remoteJidAlt;
  const phoneJid = jid.endsWith("@s.whatsapp.net") ? jid : alternate?.endsWith("@s.whatsapp.net") ? alternate : null;
  const numeroUsuario = phoneJid ? jidDecode(phoneJid)?.user || null : null;
  return { id: message.key.id, numeroUsuario, remitenteJid: jid };
}

async function startWhatsApp(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY || !process.env.OPENROUTER_MODEL) {
    throw new Error("Configura OPENROUTER_API_KEY y OPENROUTER_MODEL en .env");
  }
  const sheetConfig = sheetConfigFromEnv();
  const backupRuntime = sheetConfig ? new BackupRuntime(sheetConfig, process.env.APP_DATA_DIR || ".") : null;
  if (backupRuntime) await backupRuntime.start();
  const rateLimiter = new RateLimiter();
  const sessions = new Map<string, PendingSession>();
  const queues = new Map<string, Promise<void>>();
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  let activeSocket: ReturnType<typeof makeWASocket>;

  async function logPhotoWarning(jid: string, image: IncomingImage, receivedAt: number, nitidez: number, tipo: string): Promise<void> {
    const input = { nitidez, receivedAt, phone: image.numeroUsuario, jid, tipo };
    if (sheetConfig) {
      const range = await appendPhotoWarning(sheetConfig, input);
      console.log(`Foto observada registrada en FOTOS_SIN_NITIDEZ (${range})`);
    } else {
      console.log(JSON.stringify({ hoja: "FOTOS_SIN_NITIDEZ", valores: photoWarningRow(input) }));
    }
  }

  function enqueue(jid: string, job: () => Promise<void>): void {
    const previous = queues.get(jid) ?? Promise.resolve();
    const next = previous.then(job).catch(error => console.error(`Error en la cola de ${jid}:`, error));
    queues.set(jid, next);
    void next.then(() => { if (queues.get(jid) === next) queues.delete(jid); });
  }

  function closeSession(jid: string, session: PendingSession): void {
    clearTimeout(session.timer);
    if (session.batchTimer) clearTimeout(session.batchTimer);
    if (sessions.get(jid) === session) sessions.delete(jid);
  }

  async function completeSession(jid: string, session: PendingSession): Promise<void> {
    if (!session.reading || !session.invoice || !session.lastValidSentAt) return;
    const input = {
      phone: session.phone,
      jid,
      sentAt: session.lastValidSentAt,
      reading: session.reading,
      invoice: session.invoice,
    };
    const row = readingRow(input);
    if (sheetConfig) {
      let backupId: string | null = null;
      if (backupRuntime && session.dashboardPhoto && session.invoicePhoto && session.dashboardMessageId && session.invoiceMessageId && session.invoice.placa) {
        backupId = stableRecordId(jid, session.dashboardMessageId, session.invoiceMessageId, session.invoice.placa, String(row[3]), String(row[4]));
        let stage: "COMPLETE" | "EXISTING" | "STAGED" | null = null;
        try {
          stage = await backupRuntime.stage({
            idRegistro: backupId, phone: session.phone, jid, claimedPlate: session.invoice.placa,
            fecha: String(row[3]), hora: String(row[4]), signature: registrationSignature(row),
            factura: { buffer: session.invoicePhoto.bytes, mimeType: session.invoicePhoto.image.mime },
            kilometraje: { buffer: session.dashboardPhoto.bytes, mimeType: session.dashboardPhoto.image.mime },
          });
        } catch (error) {
          console.error("No se pudo persistir el respaldo de fotos:", error instanceof Error ? error.message : "error desconocido");
          backupId = null;
        }
        if (backupId && (stage === "COMPLETE" || await backupRuntime.alreadyRegistered(backupId))) {
          console.log(`Registro ${backupId} ya procesado; se evita repetir la fila de Matriz.`);
          closeSession(jid, session);
          await activeSocket.sendMessage(jid, { text: mensajeRegistroExitoso });
          return;
        }
      }
      const range = await appendReading(sheetConfig, input);
      console.log(`Lectura y factura guardadas en Google Sheets (${range})`);
      if (backupId && backupRuntime) {
        try { await backupRuntime.markRegistered(backupId, range); }
        catch (error) { console.error("Matriz se guardó, pero el respaldo quedó pendiente de conciliación:", error instanceof Error ? error.message : "error desconocido"); }
      }
    } else {
      console.log(JSON.stringify({
        telf: row[0],
        fecha_mensaje_whatsapp: row[3],
        hora_mensaje_whatsapp: row[4],
        remitente_jid: jid,
        mensaje_tablero_id: session.dashboardMessageId,
        mensaje_factura_id: session.invoiceMessageId,
        modelo: process.env.OPENROUTER_MODEL,
        ...session.reading,
        ...session.invoice,
      }));
    }
    closeSession(jid, session);
    try {
      await activeSocket.sendMessage(jid, { text: mensajeRegistroExitoso });
    } catch (error) {
      console.error(`Registro completo para ${jid}, pero falló el envío de la confirmación:`, error);
    }
  }

  async function requestClarification(jid: string, session: PendingSession): Promise<void> {
    if (!session.reading || !session.invoice) return;
    const fields = fieldsToClarify(session.reading, session.invoice);
    const dashboardFields = fields.filter(field => field === "KILOMETRAJE" || field === "COMBUSTIBLE");
    const invoiceFields = fields.filter(field => field !== "KILOMETRAJE" && field !== "COMBUSTIBLE");
    const errors = validationMessage(invoiceFields.map(field => `No se ve ${field}`), dashboardFields.map(field => `No se ve ${field}`));
    const guidance = `Envía los campos indicados en un solo mensaje de texto, uno por línea con formato CAMPO: valor. Tienes 1 minuto. Para COMBUSTIBLE incluye estado y porcentaje (ej.: COMBUSTIBLE: medio 50%). Campos: ${fields.join(", ")}.`;
    await activeSocket.sendMessage(jid, { text: `${errors}\n${guidance}` });
    clearTimeout(session.timer);
    const deadline = Date.now() + CLARIFICATION_WINDOW_MS;
    session.deadline = deadline;
    session.awaitingClarification = { fields, deadline };
    session.timer = setTimeout(() => {
      enqueue(jid, async () => {
        if (sessions.get(jid) !== session || !session.awaitingClarification) return;
        closeSession(jid, session);
        await activeSocket.sendMessage(jid, { text: "No recibí la aclaración en 1 minuto. Sesión cerrada; envía las dos fotos de nuevo." });
      });
    }, CLARIFICATION_WINDOW_MS);
  }

  async function acceptClarification(jid: string, session: PendingSession, text: string | null, receivedAt: number): Promise<void> {
    const pending = session.awaitingClarification;
    if (!pending) return;
    if (receivedAt > pending.deadline) {
      closeSession(jid, session);
      await activeSocket.sendMessage(jid, { text: "Terminó el minuto para aclarar los campos. Envía las dos fotos de nuevo." });
      return;
    }
    if (!text || !session.reading || !session.invoice) {
      await activeSocket.sendMessage(jid, { text: "Envía la aclaración como mensaje de texto con formato CAMPO: valor." });
      return;
    }
    const result = applyClarification(session.reading, session.invoice, pending.fields, text);
    if (!result.ok) {
      await activeSocket.sendMessage(jid, { text: `${result.errors.join("\n")}\nCorrige y envía todos los campos solicitados antes de que termine el minuto.` });
      return;
    }
    const detail = text.trim().replace(/\s+/g, " ");
    try {
      if (pending.fields.some(field => field === "KILOMETRAJE" || field === "COMBUSTIBLE") && session.dashboardPhoto) {
        const { image } = session.dashboardPhoto;
        await logPhotoWarning(jid, image, receivedAt, session.reading.nitidez_pct, `TABLERO - ACLARACIÓN DEL USUARIO: ${detail}`);
      }
      if (pending.fields.some(field => field !== "KILOMETRAJE" && field !== "COMBUSTIBLE") && session.invoicePhoto) {
        const { image } = session.invoicePhoto;
        await logPhotoWarning(jid, image, receivedAt, session.invoice.nitidez_pct, `FACTURA - ACLARACIÓN DEL USUARIO: ${detail}`);
      }
    } catch (error) {
      console.error(`No se registró la aclaración de ${jid}:`, error);
      await activeSocket.sendMessage(jid, { text: "No pude registrar la aclaración. Envíala otra vez antes de que termine el minuto." });
      return;
    }
    session.reading = result.reading;
    session.invoice = result.invoice;
    session.awaitingClarification = undefined;
    try {
      await completeSession(jid, session);
    } catch (error) {
      console.error(`No se guardó el registro aclarado de ${jid}:`, error);
      await activeSocket.sendMessage(jid, { text: "No pude guardar el registro. Envía las dos fotos de nuevo." });
      closeSession(jid, session);
    }
  }

  async function flushBatch(jid: string, session: PendingSession, final = false): Promise<void> {
    if (sessions.get(jid) !== session || rateLimiter.isBlocked(jid)) return;
    if (session.batchTimer) clearTimeout(session.batchTimer);
    session.batchTimer = undefined;
    const photos = session.photos.splice(0);
    if (!photos.length) return;
    const invoiceErrors: string[] = [];
    const dashboardErrors: string[] = [];

    for (const { message, image, receivedAt } of photos) {
      try {
        const sentAt = whatsappSentAt(message);
        if (!sentAt) {
          const error = "FECHA y HORA del mensaje de WhatsApp no disponibles";
          if (session.invoice && !session.reading) dashboardErrors.push(error);
          else if (session.reading && !session.invoice) invoiceErrors.push(error);
          else { invoiceErrors.push(error); dashboardErrors.push(error); }
          continue;
        }
        const bytes = await downloadMediaMessage(message, "buffer", {});
        const invoice = await analyzeInvoice(bytes, image.mime);
        if (invoice.es_factura) {
          console.log(`Factura recibida (${image.id}): ${JSON.stringify(invoice)}`);
          console.log(`Nitidez factura (${image.id}): ${invoice.nitidez_pct}%`);
          console.log(`Confianza factura (${image.id}): ${invoice.confianza_lectura_pct}%`);
          const missingInvoiceFields = camposFacturaFaltantes(invoice);
          if (!invoice.numero_factura?.trim()) missingInvoiceFields.push("NÚMERO DE FACTURA");
          if ((invoice.nitidez_pct >= 30 && invoice.nitidez_pct < 80) || missingInvoiceFields.length > 0) {
            const tipo = missingInvoiceFields.length ? `FACTURA - ${missingInvoiceFields.map(field => `${field} NO SE VE`).join(", ")}` : "FACTURA";
            try { await logPhotoWarning(jid, image, receivedAt, invoice.nitidez_pct, tipo); }
            catch (error) {
              console.error(`No se registró la advertencia de factura ${image.id}:`, error);
              invoiceErrors.push("No pude registrar la nitidez de la factura en FOTOS_SIN_NITIDEZ");
              continue;
            }
          }
          const issues = invoiceIssues(invoice);
          if (!facturaLegible(invoice)) invoiceErrors.push(...(issues.length ? issues : ["No se pudieron validar todos los campos de la factura"]));
          session.invoice = invoice;
          session.invoicePhoto = { image, receivedAt, bytes };
          session.invoiceMessageId = image.id;
          session.lastValidSentAt = sentAt;
          session.phone ??= image.numeroUsuario;
          if (session.reading && lecturaConfiable(session.reading) && facturaLegible(invoice)) break;
          continue;
        }

        const reading = await analyzeImage(bytes, image.mime);
        console.log(`Kilometraje leído (${image.id}): ${reading.kilometraje_km === null ? "no disponible" : `${reading.kilometraje_km} km`}`);
        console.log(`Confianza del kilometraje (${image.id}): ${reading.confianza_kilometraje_pct === null ? "no disponible" : `${reading.confianza_kilometraje_pct}%`}`);
        console.log(`Nitidez tablero (${image.id}): ${reading.nitidez_pct}%`);
        console.log(`Confianza tablero (${image.id}): ${reading.confianza_lectura_pct}%`);
        const missingDashboardFields: string[] = [];
        if (reading.kilometraje_km === null || reading.confianza_kilometraje_pct === null || reading.confianza_kilometraje_pct < 30) missingDashboardFields.push("KILOMETRAJE");
        if (reading.gasolina_estado === "no_legible" || reading.gasolina_porcentaje_aproximado === null) missingDashboardFields.push("COMBUSTIBLE");
        if ((reading.nitidez_pct >= 30 && reading.nitidez_pct < 80) || missingDashboardFields.length > 0) {
          const tipo = missingDashboardFields.length ? `TABLERO - ${missingDashboardFields.map(field => `${field} NO SE VE`).join(", ")}` : "TABLERO";
          try { await logPhotoWarning(jid, image, receivedAt, reading.nitidez_pct, tipo); }
          catch (error) {
            console.error(`No se registró la advertencia de tablero ${image.id}:`, error);
            dashboardErrors.push("No pude registrar la nitidez del tablero en FOTOS_SIN_NITIDEZ");
            continue;
          }
        }
        const issues = dashboardIssues(reading);
        if (!lecturaConfiable(reading)) dashboardErrors.push(...(issues.length ? issues : ["No se pudieron validar todos los datos del tablero"]));
        session.reading = reading;
        session.dashboardPhoto = { image, receivedAt, bytes };
        session.dashboardMessageId = image.id;
        session.lastValidSentAt = sentAt;
        session.phone ??= image.numeroUsuario;
        if (session.invoice && facturaLegible(session.invoice) && lecturaConfiable(reading)) break;
      } catch (error) {
        console.error(`Error al procesar ${image.id}:`, error);
        const detail = "No pude procesar la foto; envíala otra vez";
        if (session.invoice && !session.reading) dashboardErrors.push(detail);
        else if (session.reading && !session.invoice) invoiceErrors.push(detail);
        else { invoiceErrors.push(detail); dashboardErrors.push(detail); }
      }
    }

    if (session.reading && session.invoice) {
      if (lecturaConfiable(session.reading) && facturaLegible(session.invoice)) {
        try {
          await completeSession(jid, session);
        } catch (error) {
          console.error(`Error al guardar el registro de ${jid}:`, error);
          if (final) {
            closeSession(jid, session);
            await activeSocket.sendMessage(jid, { text: "No pude guardar el registro y la sesión de 5 minutos se cerró. Envía las dos fotos de nuevo." });
          } else {
            await activeSocket.sendMessage(jid, { text: "No pude guardar el registro. La sesión sigue activa; envía de nuevo la última foto." });
          }
        }
        return;
      }
      if (session.reading.nitidez_pct >= 30 && session.invoice.nitidez_pct >= 30 && fieldsToClarify(session.reading, session.invoice).length > 0) {
        await requestClarification(jid, session);
        return;
      }
      const errors = validationMessage(invoiceIssues(session.invoice), dashboardIssues(session.reading));
      if (final) {
        closeSession(jid, session);
        await activeSocket.sendMessage(jid, { text: `${errors}\nSesión cerrada.` });
      } else await activeSocket.sendMessage(jid, { text: errors });
      return;
    }

    if ((session.reading || session.invoice) && !final && !(session.reading && session.invoice)) {
      const request = session.invoice ? pedirKilometraje : pedirFactura;
      const errors = validationMessage(invoiceErrors, dashboardErrors);
      await activeSocket.sendMessage(jid, { text: `${errors ? `${errors}\n` : ""}${primeraFotoRecibida}\n${request}` });
      return;
    }
    const hasPhotoErrors = invoiceErrors.length > 0 || dashboardErrors.length > 0;
    if (!hasPhotoErrors && !session.invoice) invoiceErrors.push("Falta foto de factura");
    if (!hasPhotoErrors && !session.reading) dashboardErrors.push("Falta foto de tablero");
    const result = validationMessage(invoiceErrors, dashboardErrors);
    if (final) {
      closeSession(jid, session);
      await activeSocket.sendMessage(jid, { text: `${result}\nSesión cerrada.` });
    } else {
      await activeSocket.sendMessage(jid, { text: hasPhotoErrors ? result : `${result}\nEnvía la foto que falta.` });
    }
  }

  function startSession(jid: string, receivedAt: number, phone: string | null): PendingSession {
    const deadline = receivedAt + SESSION_WINDOW_MS;
    const session: PendingSession = {
      deadline,
      phone,
      photos: [],
      timer: setTimeout(() => {
        enqueue(jid, async () => {
          if (sessions.get(jid) !== session || session.awaitingClarification) return;
          if (session.photos.length) await flushBatch(jid, session, true);
          else {
            closeSession(jid, session);
            console.log(`Sesión cerrada por tiempo para ${jid}`);
            await activeSocket.sendMessage(jid, { text: sesionExpirada });
          }
        });
      }, Math.max(0, deadline - Date.now())),
    };
    sessions.set(jid, session);
    return session;
  }

  async function acceptPhoto(message: WAMessage, image: IncomingImage, receivedAt: number): Promise<void> {
    const jid = image.remitenteJid;
    if (rateLimiter.isBlocked(jid)) return;
    let session = sessions.get(jid);
    if (session && receivedAt > session.deadline) {
      const wasClarifying = Boolean(session.awaitingClarification);
      closeSession(jid, session);
      await activeSocket.sendMessage(jid, { text: wasClarifying ? "Terminó el minuto para aclarar los campos. Envía las dos fotos de nuevo." : sesionExpirada });
      return;
    }
    if (session?.awaitingClarification) {
      await activeSocket.sendMessage(jid, { text: "Ya recibí las dos fotos. Envía los campos solicitados en un mensaje de texto antes de que termine el minuto." });
      return;
    }
    session ??= startSession(jid, receivedAt, image.numeroUsuario);
    session.photos.push({ message, image, receivedAt });
    if (!session.batchTimer) {
      const batchAt = receivedAt + PHOTO_BATCH_MS;
      session.batchTimer = setTimeout(() => {
        enqueue(jid, () => flushBatch(jid, session));
      }, Math.max(0, batchAt - Date.now()));
    }
  }

  function connect(): void {
    const sock = makeWASocket({ auth: state, markOnlineOnConnect: false });
    activeSocket = sock;
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", ({ connection, qr, lastDisconnect }) => {
      if (qr) {
        console.log("Escanea este QR en WhatsApp > Dispositivos vinculados > Vincular dispositivo:");
        qrcode.generate(qr, { small: true });
      }
      if (connection === "open") console.log("WhatsApp conectado. Envía una foto del tablero o de la factura desde otro chat privado.");
      if (connection === "close") {
        const status = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        if (status === DisconnectReason.loggedOut) {
          console.error(`Sesión de WhatsApp cerrada. Elimina ${SESSION_DIR} y vuelve a ejecutar para escanear otro QR.`);
          return;
        }
        console.log(`Conexión cerrada (${status ?? "sin código"}). Reconectando...`);
        setTimeout(connect, 1000);
      }
    });
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      for (const message of messages) {
        const sender = incomingSender(message);
        if (!sender) continue;
        const key = `${sender.remitenteJid}:${sender.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const receivedAt = Date.now();
        const rate = rateLimiter.check(sender.remitenteJid, receivedAt);
        if (rate !== "allowed") {
          if (rate === "just_blocked") {
            const session = sessions.get(sender.remitenteJid);
            if (session) closeSession(sender.remitenteJid, session);
            console.log(`Chat ${sender.remitenteJid} bloqueado por 8 horas: más de 50 mensajes en 1 minuto`);
            enqueue(sender.remitenteJid, async () => { await activeSocket.sendMessage(sender.remitenteJid, { text: limiteAlcanzado }); });
          }
          continue;
        }
        const image = incomingImage(message);
        if (image) {
          console.log(`Foto recibida de ${image.numeroUsuario ?? image.remitenteJid} (mensaje ${image.id})`);
          enqueue(image.remitenteJid, () => acceptPhoto(message, image, receivedAt));
        } else {
          enqueue(sender.remitenteJid, async () => {
            if (rateLimiter.isBlocked(sender.remitenteJid)) return;
            const session = sessions.get(sender.remitenteJid);
            if (session?.awaitingClarification) {
              await acceptClarification(sender.remitenteJid, session, incomingText(message), receivedAt);
              return;
            }
            if (session && receivedAt <= session.deadline) await activeSocket.sendMessage(sender.remitenteJid, { text: contenidoInvalido });
          });
        }
      }
    });
  }

  connect();
}

async function main(): Promise<void> {
  const imagePath = process.argv[2];
  if (imagePath) {
    const mimeByExtension: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };
    const mime = mimeByExtension[extname(imagePath).toLowerCase()];
    if (!mime) throw new Error("Usa una imagen JPG, PNG, WEBP o GIF");
    console.log(JSON.stringify({ modelo: process.env.OPENROUTER_MODEL, ...await analyzeImage(await readFile(imagePath), mime) }));
  } else {
    await startWhatsApp();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
