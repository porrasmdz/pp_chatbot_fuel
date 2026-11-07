import type { DashboardReading } from "./analyze.js";

export const pedirFactura =
  "Ya leí el kilometraje. Envíame la foto clara de la factura de combustible. La sesión vence 20 segundos después de la primera foto.";

export const pedirKilometraje =
  "Ya leí la factura. Envíame una foto clara del tablero con el kilometraje. La sesión vence 20 segundos después de la primera foto.";

export const sesionExpirada =
  "La sesión se cerró porque no recibí las dos fotos dentro de 20 segundos. Envía una foto del tablero o de la factura para comenzar de nuevo.";

export const sesionCompletada =
  "Recibí las dos fotos y registré los datos. La sesión se cerró. Gracias.";

export const facturaPocoClara =
  "No pude leer la factura de combustible. Por favor, envía otra foto donde se vean claramente los datos de la recarga.";

export const MIN_CONFIDENCE_EXCLUSIVE = 80;

export const fotoPocoClara =
  "No se ve claro el kilometraje. Por favor, enfoca mejor el kilometraje y envía otra foto.";

export function lecturaConfiable(reading: DashboardReading): boolean {
  return reading.kilometraje_km !== null
    && reading.confianza_kilometraje_pct !== null
    && reading.confianza_kilometraje_pct > MIN_CONFIDENCE_EXCLUSIVE;
}

export function lecturaConfirmada(reading: DashboardReading): string {
  if (reading.kilometraje_km === null) throw new Error("No hay kilometraje para confirmar");
  const combustible = reading.gasolina_porcentaje_aproximado === null
    ? reading.gasolina_estado
    : `${reading.gasolina_estado} (${reading.gasolina_porcentaje_aproximado}%)`;
  return `Gracias. Leímos ${reading.kilometraje_km} km en el tablero. Combustible: ${combustible}.`;
}
