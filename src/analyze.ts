import { analyzePhoto } from "./vision.js";

type FuelState = "vacio" | "reserva" | "bajo" | "medio" | "alto" | "lleno" | "no_legible";
export type DashboardReading = {
  kilometraje_km: number | null;
  confianza_kilometraje_pct: number | null;
  gasolina_estado: FuelState;
  gasolina_porcentaje_aproximado: number | null;
  observaciones: string;
};

export async function analyzeImage(bytes: Buffer, mime: string): Promise<DashboardReading> {
  const reading = await analyzePhoto<DashboardReading>(
    bytes,
    mime,
    "lectura_tablero",
    "Lee únicamente el tablero del vehículo en la imagen. No inventes cifras. Kilometraje significa odómetro total, no velocidad ni autonomía restante. Si el odómetro no se ve claramente, usa null para kilometraje_km y confianza_kilometraje_pct. Si lo lees, indica confianza_kilometraje_pct como un entero del 1 al 100 según la claridad de los dígitos; baja la confianza si hay reflejos, desenfoque o dígitos ambiguos. Es una estimación visual, no una probabilidad calibrada. Estima el porcentaje de combustible solo si el indicador es visible; si no, usa null y no_legible. Las observaciones deben ser breves y en español.",
    "Extrae el kilometraje total y el estado de la gasolina de este tablero.",
    {
      type: "object",
      properties: {
        kilometraje_km: { type: ["integer", "null"] },
        confianza_kilometraje_pct: { type: ["integer", "null"], description: "Confianza visual en la lectura del odómetro, de 1 a 100. Null si el kilometraje no se puede leer." },
        gasolina_estado: { type: "string", enum: ["vacio", "reserva", "bajo", "medio", "alto", "lleno", "no_legible"] },
        gasolina_porcentaje_aproximado: { type: ["integer", "null"] },
        observaciones: { type: "string" },
      },
      required: ["kilometraje_km", "confianza_kilometraje_pct", "gasolina_estado", "gasolina_porcentaje_aproximado", "observaciones"],
      additionalProperties: false,
    },
  );
  const confidence = reading.confianza_kilometraje_pct;
  if (reading.kilometraje_km === null ? confidence !== null : !Number.isInteger(confidence) || confidence! < 1 || confidence! > 100) {
    throw new Error("Confianza del kilometraje inválida en la respuesta del modelo");
  }
  return reading;
}
