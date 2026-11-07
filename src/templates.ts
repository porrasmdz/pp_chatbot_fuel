import type { DashboardReading } from "./analyze.js";

export const pedirFactura =
  "Envía la foto de la factura.";

export const pedirKilometraje =
  "Envía la foto del tablero.";

export const primeraFotoRecibida =
  "Primera foto recibida. Sesión activa por 5 minutos.";

export const sesionExpirada =
  "Sesión cerrada: faltó una foto válida dentro de 5 minutos.";

export const sesionCompletada =
  "✅ Registro guardado. Sesión cerrada.";

export const sesionCompletadaEnConsola =
  "✅ Fotos validadas. Datos en consola. Sesión cerrada.";

export function mensajeRegistroExitoso(row: Array<string | number>, savedInSheets: boolean): string {
  return `${savedInSheets ? sesionCompletada : sesionCompletadaEnConsola} ${row[1]} km.`;
}

export const contenidoInvalido = "CONTENIDO INVÁLIDO";

export const limiteAlcanzado =
  "Superaste el límite de 50 mensajes por minuto. Este chat queda bloqueado durante 8 horas.";

export const tableroPocoClaro =
  "Alerta de validación: el tablero tiene nitidez o confianza menor al 30 %, o faltan datos legibles. Enfoca mejor el kilometraje y el indicador de combustible y envía otra foto.";

export const facturaPocoClara =
  "Alerta de validación: la factura tiene nitidez o confianza menor al 30 %, o faltan campos legibles. Enfoca toda la factura y envía otra foto.";

export const MIN_CONFIDENCE = 30;

export const fotoPocoClara =
  "Alerta de validación: no se ve el kilometraje o su confianza es menor al 30 %. Enfoca mejor el kilometraje y envía otra foto.";

export function lecturaConfiable(reading: DashboardReading): boolean {
  return reading.kilometraje_km !== null
    && reading.nitidez_pct >= 30
    && reading.confianza_lectura_pct >= 30
    && Number.isInteger(reading.kilometraje_km)
    && reading.kilometraje_km >= 0
    && reading.confianza_kilometraje_pct !== null
    && reading.confianza_kilometraje_pct >= MIN_CONFIDENCE
    && reading.gasolina_estado !== "no_legible"
    && reading.gasolina_porcentaje_aproximado !== null
    && Number.isInteger(reading.gasolina_porcentaje_aproximado)
    && reading.gasolina_porcentaje_aproximado >= 0
    && reading.gasolina_porcentaje_aproximado <= 100;
}

export function lecturaConfirmada(reading: DashboardReading): string {
  if (reading.kilometraje_km === null) throw new Error("No hay kilometraje para confirmar");
  const combustible = reading.gasolina_porcentaje_aproximado === null
    ? reading.gasolina_estado
    : `${reading.gasolina_estado} (${reading.gasolina_porcentaje_aproximado}%)`;
  return `Gracias. Leímos ${reading.kilometraje_km} km en el tablero. Combustible: ${combustible}.`;
}
