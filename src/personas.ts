import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";
import type { SheetConfig } from "./sheets.js";
import { registrationSignature } from "./drive-backup-queue.js";

export type PersonaVehiculo = { placa: string; empleado: string };

function plateKey(value: string): string { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }
function phoneKey(value: string): string {
  const raw = value.trim().toLowerCase();
  if (raw.endsWith("@lid")) return raw;
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0") && digits.length === 10) digits = `593${digits.slice(1)}`;
  if (digits.length === 9 && digits.startsWith("9")) digits = `593${digits}`;
  return digits;
}

export function identifyPerson(rows: Array<Array<string | number>>, phone: string | null, jid: string, claimedPlate: string): PersonaVehiculo | null {
  const sender = phoneKey(phone || jid);
  const plate = plateKey(claimedPlate);
  if (!sender || !plate) return null;
  const header = rows.findIndex(row => String(row[0] ?? "").trim().toUpperCase() === "TELF" && String(row[2] ?? "").trim().toUpperCase() === "PLACA");
  if (header < 0) throw new Error("Personas no contiene las columnas TELF, NOMBRE y PLACA en A:C");
  const matches = rows.slice(header + 1).filter(row => phoneKey(String(row[0] ?? "")) === sender && plateKey(String(row[2] ?? "")) === plate);
  const identities = [...new Map(matches.map(row => {
    const placa = String(row[2] ?? "").trim().toUpperCase();
    const empleado = String(row[1] ?? "").trim();
    return [`${placa}|${empleado}`, { placa, empleado }];
  })).values()].filter(item => item.empleado);
  if (identities.length > 1) throw new Error("Personas contiene identidades contradictorias para este teléfono y placa");
  return identities[0] ?? null;
}

export async function lookupPerson(config: SheetConfig, phone: string | null, jid: string, claimedPlate: string): Promise<PersonaVehiculo | null> {
  const auth = new GoogleAuth({ keyFile: config.credentialsPath, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
  const sheets = google.sheets({ version: "v4", auth });
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: config.spreadsheetId, range: "Personas!A:C", valueRenderOption: "UNFORMATTED_VALUE" });
  return identifyPerson((response.data.values ?? []) as Array<Array<string | number>>, phone, jid, claimedPlate);
}

export async function registeredSignatures(config: SheetConfig): Promise<Set<string>> {
  const auth = new GoogleAuth({ keyFile: config.credentialsPath, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
  const sheets = google.sheets({ version: "v4", auth });
  const safeSheetName = config.sheetName.replaceAll("'", "''");
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId, range: `'${safeSheetName}'!A:Q`,
    valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER",
  });
  return new Set((response.data.values ?? []).slice(1).map(row => registrationSignature(row)));
}
