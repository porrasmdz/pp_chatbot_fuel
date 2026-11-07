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
];

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
  input: { phone: string | null; jid: string; reading: DashboardReading; invoice: InvoiceReading },
): Array<string | number> {
  const combustible = input.reading.gasolina_porcentaje_aproximado === null
    ? input.reading.gasolina_estado
    : `${input.reading.gasolina_estado} (${input.reading.gasolina_porcentaje_aproximado}%)`;
  return [
    input.phone ?? input.jid,
    input.reading.kilometraje_km ?? "",
    combustible,
    input.invoice.fecha_factura ?? "",
    input.invoice.hora_factura ?? "",
    input.invoice.precio_por_galon ?? "",
    input.invoice.galones ?? "",
    input.invoice.tipo_combustible ?? "",
    input.invoice.valor_recarga ?? "",
  ];
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
    range: `'${safeSheetName}'!A:I`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [readingRow(input)] },
  });
  if (result.data.updates?.updatedRows !== 1) throw new Error("Google Sheets no confirmó la fila agregada");
  return result.data.updates.updatedRange || "fila agregada";
}
