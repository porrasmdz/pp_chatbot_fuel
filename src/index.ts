import { readFile } from "node:fs/promises";
import { extname } from "node:path";
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
import { analyzeInvoice, facturaLegible, type InvoiceReading } from "./invoice.js";
import { appendReading, sheetConfigFromEnv, type SheetConfig } from "./sheets.js";
import { facturaPocoClara, fotoPocoClara, lecturaConfiable, pedirFactura, pedirKilometraje, sesionCompletada, sesionExpirada } from "./templates.js";

const SESSION_DIR = "auth_info_baileys";
const SESSION_WINDOW_MS = 60_000;
const seen = new Set<string>();
type IncomingImage = { id: string; mime: string; numeroUsuario: string | null; remitenteJid: string };
type PendingSession = {
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  phone: string | null;
  reading?: DashboardReading;
  invoice?: InvoiceReading;
  dashboardMessageId?: string;
  invoiceMessageId?: string;
};

export function incomingImage(message: WAMessage): IncomingImage | null {
  const jid = message.key.remoteJid;
  if (message.key.fromMe || !jid || !(jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid")) || !message.key.id) return null;
  const image = extractMessageContent(message.message)?.imageMessage;
  if (!image) return null;
  const numeroUsuario = jid.endsWith("@s.whatsapp.net") ? jidDecode(jid)?.user || null : null;
  return { id: message.key.id, mime: image.mimetype || "image/jpeg", numeroUsuario, remitenteJid: jid };
}

async function startWhatsApp(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY || !process.env.OPENROUTER_MODEL) {
    throw new Error("Configura OPENROUTER_API_KEY y OPENROUTER_MODEL en .env");
  }
  const sheetConfig = sheetConfigFromEnv();
  const sessions = new Map<string, PendingSession>();
  const queues = new Map<string, Promise<void>>();
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  let activeSocket: ReturnType<typeof makeWASocket>;

  function enqueue(jid: string, job: () => Promise<void>): void {
    const previous = queues.get(jid) ?? Promise.resolve();
    const next = previous.then(job).catch(error => console.error(`Error en la cola de ${jid}:`, error));
    queues.set(jid, next);
    void next.then(() => { if (queues.get(jid) === next) queues.delete(jid); });
  }

  function startSession(jid: string, receivedAt: number, data: Omit<PendingSession, "deadline" | "timer">): void {
    const deadline = receivedAt + SESSION_WINDOW_MS;
    const session: PendingSession = {
      ...data,
      deadline,
      timer: setTimeout(() => {
        enqueue(jid, async () => {
          if (sessions.get(jid) !== session) return;
          sessions.delete(jid);
          console.log(`Sesión cerrada por tiempo para ${jid}`);
          await activeSocket.sendMessage(jid, { text: sesionExpirada });
        });
      }, Math.max(0, deadline - Date.now())),
    };
    sessions.set(jid, session);
  }

  async function completeSession(jid: string, image: IncomingImage, session: PendingSession, config: SheetConfig | null): Promise<void> {
    if (!session.reading || !session.invoice) return;
    if (config) {
      const range = await appendReading(config, {
        phone: session.phone ?? image.numeroUsuario,
        jid,
        reading: session.reading,
        invoice: session.invoice,
      });
      console.log(`Lectura y factura guardadas en Google Sheets (${range})`);
    } else {
      console.log(JSON.stringify({
        numero_usuario: session.phone ?? image.numeroUsuario,
        remitente_jid: jid,
        mensaje_tablero_id: session.dashboardMessageId,
        mensaje_factura_id: session.invoiceMessageId,
        modelo: process.env.OPENROUTER_MODEL,
        ...session.reading,
        ...session.invoice,
      }));
    }
    clearTimeout(session.timer);
    sessions.delete(jid);
    await activeSocket.sendMessage(jid, { text: sesionCompletada });
  }

  async function processPhoto(message: WAMessage, image: IncomingImage, receivedAt: number, config: SheetConfig | null): Promise<void> {
    const jid = image.remitenteJid;
    const key = `${jid}:${image.id}`;
    try {
      const pending = sessions.get(jid);
      if (pending && receivedAt > pending.deadline) {
        clearTimeout(pending.timer);
        sessions.delete(jid);
        console.log(`Sesión cerrada por tiempo para ${jid}`);
        await activeSocket.sendMessage(jid, { text: sesionExpirada });
        return;
      }

      const bytes = await downloadMediaMessage(message, "buffer", {});
      const invoice = await analyzeInvoice(bytes, image.mime);
      if (invoice.es_factura) {
        console.log(`Factura recibida (${image.id}): ${JSON.stringify(invoice)}`);
        if (!facturaLegible(invoice)) {
          await activeSocket.sendMessage(jid, { text: facturaPocoClara });
          return;
        }
        if (!pending) {
          await activeSocket.sendMessage(jid, { text: pedirKilometraje });
          startSession(jid, receivedAt, { phone: image.numeroUsuario, invoice, invoiceMessageId: image.id });
          console.log(`Kilometraje solicitado a ${image.numeroUsuario ?? jid}`);
          return;
        }
        if (pending.invoice) {
          await activeSocket.sendMessage(jid, { text: pedirKilometraje });
          return;
        }
        pending.invoice = invoice;
        pending.invoiceMessageId = image.id;
        await completeSession(jid, image, pending, config);
        return;
      }

      const reading = await analyzeImage(bytes, image.mime);
      console.log(`Kilometraje leído (${image.id}): ${reading.kilometraje_km === null ? "no disponible" : `${reading.kilometraje_km} km`}`);
      console.log(`Confianza del kilometraje (${image.id}): ${reading.confianza_kilometraje_pct === null ? "no disponible" : `${reading.confianza_kilometraje_pct}%`}`);
      if (!lecturaConfiable(reading)) {
        await activeSocket.sendMessage(jid, { text: fotoPocoClara });
        return;
      }
      if (!pending) {
        await activeSocket.sendMessage(jid, { text: pedirFactura });
        startSession(jid, receivedAt, { phone: image.numeroUsuario, reading, dashboardMessageId: image.id });
        console.log(`Factura solicitada a ${image.numeroUsuario ?? jid}`);
        return;
      }
      if (pending.reading) {
        await activeSocket.sendMessage(jid, { text: pedirFactura });
        return;
      }
      pending.reading = reading;
      pending.dashboardMessageId = image.id;
      await completeSession(jid, image, pending, config);
    } catch (error) {
      seen.delete(key);
      console.error(`Error al procesar ${image.id}:`, error);
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
        const image = incomingImage(message);
        if (!image) continue;
        const key = `${image.remitenteJid}:${image.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const receivedAt = Date.now();
        console.log(`Foto recibida de ${image.numeroUsuario ?? image.remitenteJid} (mensaje ${image.id})`);
        enqueue(image.remitenteJid, () => processPhoto(message, image, receivedAt, sheetConfig));
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
