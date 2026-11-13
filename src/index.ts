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
import { analyzeInvoice, camposFacturaFaltantes, facturaLegible, type InvoiceReading } from "./invoice.js";
import { RateLimiter } from "./rate-limit.js";
import { appendPhotoWarning, appendReading, photoWarningRow, readingRow, sheetConfigFromEnv } from "./sheets.js";
import { contenidoInvalido, lecturaConfiable, limiteAlcanzado, mensajeRegistroExitoso, pedirFactura, pedirKilometraje, primeraFotoRecibida, sesionExpirada } from "./templates.js";
import { dashboardIssues, invoiceIssues, validationMessage } from "./validation.js";

const SESSION_DIR = join(process.env.APP_DATA_DIR || ".", "auth_info_baileys");
const SESSION_WINDOW_MS = 5 * 60_000;
const PHOTO_BATCH_MS = 5_000;
const seen = new Set<string>();

type IncomingImage = { id: string; mime: string; numeroUsuario: string | null; remitenteJid: string };
type QueuedPhoto = { message: WAMessage; image: IncomingImage; receivedAt: number };
type PendingSession = {
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  batchTimer?: ReturnType<typeof setTimeout>;
  photos: QueuedPhoto[];
  phone: string | null;
  reading?: DashboardReading;
  invoice?: InvoiceReading;
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
  const numeroUsuario = jid.endsWith("@s.whatsapp.net") ? jidDecode(jid)?.user || null : null;
  return { id: message.key.id, numeroUsuario, remitenteJid: jid };
}

async function startWhatsApp(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY || !process.env.OPENROUTER_MODEL) {
    throw new Error("Configura OPENROUTER_API_KEY y OPENROUTER_MODEL en .env");
  }
  const sheetConfig = sheetConfigFromEnv();
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
      const range = await appendReading(sheetConfig, input);
      console.log(`Lectura y factura guardadas en Google Sheets (${range})`);
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
          if ((invoice.nitidez_pct >= 30 && invoice.nitidez_pct < 80) || !invoice.numero_factura?.trim()) {
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
          else {
            session.invoice = invoice;
            session.invoiceMessageId = image.id;
            session.lastValidSentAt = sentAt;
            session.phone ??= image.numeroUsuario;
            if (session.reading) break;
          }
          continue;
        }

        const reading = await analyzeImage(bytes, image.mime);
        console.log(`Kilometraje leído (${image.id}): ${reading.kilometraje_km === null ? "no disponible" : `${reading.kilometraje_km} km`}`);
        console.log(`Confianza del kilometraje (${image.id}): ${reading.confianza_kilometraje_pct === null ? "no disponible" : `${reading.confianza_kilometraje_pct}%`}`);
        console.log(`Nitidez tablero (${image.id}): ${reading.nitidez_pct}%`);
        console.log(`Confianza tablero (${image.id}): ${reading.confianza_lectura_pct}%`);
        if (reading.nitidez_pct >= 30 && reading.nitidez_pct < 80) {
          const missingDashboardFields: string[] = [];
          if (reading.kilometraje_km === null) missingDashboardFields.push("KILOMETRAJE");
          if (reading.gasolina_estado === "no_legible" || reading.gasolina_porcentaje_aproximado === null) missingDashboardFields.push("COMBUSTIBLE");
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
        else {
          session.reading = reading;
          session.dashboardMessageId = image.id;
          session.lastValidSentAt = sentAt;
          session.phone ??= image.numeroUsuario;
          if (session.invoice) break;
        }
      } catch (error) {
        console.error(`Error al procesar ${image.id}:`, error);
        const detail = "No pude procesar la foto; envíala otra vez";
        if (session.invoice && !session.reading) dashboardErrors.push(detail);
        else if (session.reading && !session.invoice) invoiceErrors.push(detail);
        else { invoiceErrors.push(detail); dashboardErrors.push(detail); }
      }
    }

    if (session.reading && session.invoice) {
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

    if (photos.length === 1 && invoiceErrors.length === 0 && dashboardErrors.length === 0 && !final) {
      const request = session.invoice ? pedirKilometraje : pedirFactura;
      await activeSocket.sendMessage(jid, { text: `${primeraFotoRecibida}\n${request}` });
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
          if (sessions.get(jid) !== session) return;
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
      closeSession(jid, session);
      await activeSocket.sendMessage(jid, { text: sesionExpirada });
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
