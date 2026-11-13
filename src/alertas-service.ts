import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";
import { consolidarAlertas, type AlertasData, type ResultadoAlertas, type SheetRows } from "./alertas-rules.js";

export type AlertasConfig = { spreadsheetId: string; credentialsPath: string };

const RANGES = [
  "PARAMETROS!A:B",
  "Matriz!A:S",
  "Personas!A:C",
  "Calendario!A:J",
  "Indicadores!A:M",
  "PROMEDIOS_REPOSTAJE!A:H",
] as const;

export class AlertasService {
  constructor(private readonly config: AlertasConfig) {
    if (!config.spreadsheetId || !config.credentialsPath) {
      throw new Error("Configura GOOGLE_SPREADSHEET_ID y GOOGLE_APPLICATION_CREDENTIALS");
    }
  }

  static fromEnv(): AlertasService {
    return new AlertasService({
      spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID ?? "",
      credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "",
    });
  }

  async obtenerAlertas(options: { fechaInicio?: string; fechaFin?: string } = {}): Promise<ResultadoAlertas> {
    const auth = new GoogleAuth({
      keyFile: this.config.credentialsPath,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    const sheets = google.sheets({ version: "v4", auth });
    const response = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: this.config.spreadsheetId,
      ranges: [...RANGES],
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "SERIAL_NUMBER",
    });
    const blocks = response.data.valueRanges;
    if (!blocks || blocks.length !== RANGES.length) throw new Error("Google Sheets devolvió una respuesta incompleta");
    const rows = (index: number): SheetRows => (blocks[index].values ?? []) as SheetRows;
    const data: AlertasData = {
      parametros: rows(0), matriz: rows(1), personas: rows(2),
      calendario: rows(3), indicadores: rows(4), promedios: rows(5),
    };
    return consolidarAlertas(data, options);
  }
}
