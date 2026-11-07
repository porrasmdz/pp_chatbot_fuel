import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";
import type { DashboardReading } from "./analyze.js";
import type { InvoiceReading } from "./invoice.js";

export type SheetConfig = {
  spreadsheetId: string;
  sheetName: string;
  credentialsPath: string;
};

export const SHEET_HEADERS = [
  "TELF",
  "KILOMETRAJE",
  "COMBUSTIBLE",
  "FECHA",
  "HORA",
  "Precio por Galón",
  "Galones",
  "Tipo de Combustible",
  "Valor de la Recarga",
  "PLACA",
  "RUC ESTACIÓN",
  "ESTACIÓN DE SERVICIO",
  "NÚMERO DE FACTURA",
  "FECHA FACTURA",
  "HORA FACTURA",
  "SUBTOTAL",
  "IVA",
];

export const PHOTO_WARNING_HEADERS = [
  "NITIDEZ (PORCENTAJE)",
  "FECHA (FECHA DE RECIIMIENTO)",
  "HORA (DE RECIBIMIENTO)",
  "TELF",
  "TIPO",
];

function ecuadorDateTime(date: Date): { fecha: string; hora: string } {
  if (Number.isNaN(date.getTime())) throw new Error("Fecha inválida para Google Sheets");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Guayaquil",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  return { fecha: `${parts.year}-${parts.month}-${parts.day}`, hora: `${parts.hour}:${parts.minute}:${parts.second}` };
}

export function sheetConfigFromEnv(): SheetConfig | null {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  const sheetName = process.env.GOOGLE_SHEET_NAME;
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!spreadsheetId && !sheetName && !credentialsPath) return null;
  if (!spreadsheetId || !sheetName || !credentialsPath) {
    throw new Error("Para Google Sheets configura GOOGLE_SPREADSHEET_ID, GOOGLE_SHEET_NAME y GOOGLE_APPLICATION_CREDENTIALS");
  }
  return { spreadsheetId, sheetName, credentialsPath };
}

export function readingRow(
  input: { phone: string | null; jid: string; sentAt: Date; reading: DashboardReading; invoice: InvoiceReading },
): Array<string | number> {
  const { fecha, hora } = ecuadorDateTime(input.sentAt);
  const combustible = input.reading.gasolina_porcentaje_aproximado === null
    ? input.reading.gasolina_estado
    : `${input.reading.gasolina_estado} (${input.reading.gasolina_porcentaje_aproximado}%)`;
  return [
    input.phone ?? input.jid,
    input.reading.kilometraje_km ?? "",
    combustible,
    fecha,
    hora,
    input.invoice.precio_por_galon ?? "",
    input.invoice.galones ?? "",
    input.invoice.tipo_combustible ?? "",
    input.invoice.valor_recarga ?? "",
    input.invoice.placa ?? "",
    input.invoice.ruc_estacion ?? "",
    input.invoice.estacion_servicio ?? "",
    input.invoice.numero_factura?.trim() || "",
    input.invoice.fecha_factura ?? "",
    input.invoice.hora_factura ?? "",
    input.invoice.subtotal ?? "",
    input.invoice.iva ?? "",
  ];
}

export function photoWarningRow(input: {
  nitidez: number;
  receivedAt: number;
  phone: string | null;
  jid: string;
  tipo: string;
}): Array<string | number> {
  if (!Number.isInteger(input.nitidez) || input.nitidez < 0 || input.nitidez > 100) throw new Error("Nitidez inválida");
  if (!/^(FACTURA|TABLERO)( - .+)?$/.test(input.tipo)) throw new Error("Tipo de foto inválido");
  const { fecha, hora } = ecuadorDateTime(new Date(input.receivedAt));
  return [input.nitidez, fecha, hora, input.phone ?? input.jid, input.tipo];
}

export async function appendPhotoWarning(config: SheetConfig, input: Parameters<typeof photoWarningRow>[0]): Promise<string> {
  const auth = new GoogleAuth({
    keyFile: config.credentialsPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const result = await sheets.spreadsheets.values.append({
    spreadsheetId: config.spreadsheetId,
    range: "'FOTOS_SIN_NITIDEZ'!A:E",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [photoWarningRow(input)] },
  });
  if (result.data.updates?.updatedRows !== 1) throw new Error("Google Sheets no confirmó la foto con baja nitidez");
  return result.data.updates.updatedRange || "fila agregada";
}

export async function appendReading(
  config: SheetConfig,
  input: Parameters<typeof readingRow>[0],
): Promise<string> {
  const auth = new GoogleAuth({
    keyFile: config.credentialsPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const safeSheetName = config.sheetName.replaceAll("'", "''");
  const result = await sheets.spreadsheets.values.append({
    spreadsheetId: config.spreadsheetId,
    range: `'${safeSheetName}'!A:Q`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [readingRow(input)] },
  });
  if (result.data.updates?.updatedRows !== 1) throw new Error("Google Sheets no confirmó la fila agregada");
  return result.data.updates.updatedRange || "fila agregada";
}
