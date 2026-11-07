import { analyzePhoto } from "./vision.js";

type FuelState = "vacio" | "reserva" | "bajo" | "medio" | "alto" | "lleno" | "no_legible";
export type DashboardReading = {
  nitidez_pct: number;
  confianza_lectura_pct: number;
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
    "Lee únicamente el tablero del vehículo en la imagen. No inventes cifras. Da nitidez_pct de 0 a 100 según enfoque, iluminación y reflejos. Da confianza_lectura_pct de 0 a 100 según la seguridad de toda la lectura, incluyendo odómetro y combustible. Son estimaciones visuales, no probabilidades calibradas. Kilometraje significa odómetro total, no velocidad ni autonomía restante. Si el odómetro no se ve claramente, usa null para kilometraje_km y confianza_kilometraje_pct. Si lo lees, indica confianza_kilometraje_pct como un entero de 0 a 100 según la claridad de los dígitos. Estima el porcentaje de combustible solo si el indicador es visible; si no, usa null y no_legible. Las observaciones deben ser breves y en español.",
    "Extrae el kilometraje total y el estado de la gasolina de este tablero.",
    {
      type: "object",
      properties: {
        nitidez_pct: { type: "integer", description: "Nitidez visual de 0 a 100" },
        confianza_lectura_pct: { type: "integer", description: "Confianza visual en todos los datos de 0 a 100" },
        kilometraje_km: { type: ["integer", "null"] },
        confianza_kilometraje_pct: { type: ["integer", "null"], description: "Confianza visual en la lectura del odómetro, de 1 a 100. Null si el kilometraje no se puede leer." },
        gasolina_estado: { type: "string", enum: ["vacio", "reserva", "bajo", "medio", "alto", "lleno", "no_legible"] },
        gasolina_porcentaje_aproximado: { type: ["integer", "null"] },
        observaciones: { type: "string" },
      },
      required: ["nitidez_pct", "confianza_lectura_pct", "kilometraje_km", "confianza_kilometraje_pct", "gasolina_estado", "gasolina_porcentaje_aproximado", "observaciones"],
      additionalProperties: false,
    },
  );
  for (const key of ["nitidez_pct", "confianza_lectura_pct"] as const) {
    if (!Number.isInteger(reading[key]) || reading[key] < 0 || reading[key] > 100) throw new Error(`Porcentaje inválido en tablero: ${key}`);
  }
  const confidence = reading.confianza_kilometraje_pct;
  if (reading.kilometraje_km === null ? confidence !== null : !Number.isInteger(confidence) || confidence! < 0 || confidence! > 100) {
    throw new Error("Confianza del kilometraje inválida en la respuesta del modelo");
  }
  return reading;
}
