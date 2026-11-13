import type { DashboardReading } from "./analyze.js";
import { camposFacturaFaltantes, type InvoiceReading } from "./invoice.js";

export function fieldsToClarify(reading: DashboardReading, invoice: InvoiceReading): string[] {
  const fields: string[] = [];
  if (reading.kilometraje_km === null || reading.confianza_kilometraje_pct === null || reading.confianza_kilometraje_pct < 30) fields.push("KILOMETRAJE");
  if (reading.gasolina_estado === "no_legible" || reading.gasolina_porcentaje_aproximado === null) fields.push("COMBUSTIBLE");
  return [...fields, ...camposFacturaFaltantes(invoice)];
}

function normalizeLabel(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().replace(/\s+/g, " ").toUpperCase();
}

function positiveNumber(value: string, allowZero = false): number | null {
  if (!/^\d+(?:[.,]\d+)?$/.test(value)) return null;
  const number = Number(value.replace(",", "."));
  return Number.isFinite(number) && (allowZero ? number >= 0 : number > 0) ? number : null;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

type ClarificationResult =
  | { ok: true; reading: DashboardReading; invoice: InvoiceReading }
  | { ok: false; errors: string[] };

export function applyClarification(
  reading: DashboardReading,
  invoice: InvoiceReading,
  requestedFields: string[],
  message: string,
): ClarificationResult {
  const text = message.trim();
  if (!text || text.length > 2000) return { ok: false, errors: ["Envía un mensaje de hasta 2000 caracteres."] };
  const requested = new Map(requestedFields.map(field => [normalizeLabel(field), field]));
  const supplied = new Map<string, string>();
  const errors: string[] = [];
  const lines = text.split(/[\n;]+/).map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = /^([^:=]+)\s*[:=]\s*(.+)$/.exec(line);
    if (!match) {
      if (requestedFields.length === 1 && lines.length === 1) supplied.set(requestedFields[0], line);
      else errors.push(`Usa CAMPO: valor para cada campo (${line}).`);
      continue;
    }
    const field = requested.get(normalizeLabel(match[1]));
    if (!field) {
      if (requestedFields.length === 1 && requestedFields[0] === "HORA FACTURA" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(line)) {
        supplied.set("HORA FACTURA", line);
      } else errors.push(`Campo no solicitado: ${match[1].trim()}.`);
      continue;
    }
    if (supplied.has(field)) { errors.push(`Campo repetido: ${field}.`); continue; }
    supplied.set(field, match[2].trim());
  }
  for (const field of requestedFields) if (!supplied.has(field)) errors.push(`Falta ${field}.`);
  if (errors.length) return { ok: false, errors };

  const updatedReading = { ...reading };
  const updatedInvoice = { ...invoice };
  for (const field of requestedFields) {
    const value = supplied.get(field)!;
    const number = positiveNumber(value, field === "SUBTOTAL" || field === "IVA" || field === "KILOMETRAJE");
    switch (field) {
      case "KILOMETRAJE": {
        if (number === null || !Number.isSafeInteger(number)) errors.push("KILOMETRAJE debe ser un entero no negativo.");
        else updatedReading.kilometraje_km = number;
        break;
      }
      case "COMBUSTIBLE": {
        const match = /^(?:(vacio|reserva|bajo|medio|alto|lleno)\s*)?\(?\s*(\d{1,3})\s*%\s*\)?$/i.exec(value);
        const percent = match ? Number(match[2]) : NaN;
        if (!match || percent > 100) errors.push("COMBUSTIBLE debe incluir un porcentaje entre 0 y 100 (ej.: medio 50%).");
        else {
          updatedReading.gasolina_porcentaje_aproximado = percent;
          updatedReading.gasolina_estado = (match[1]?.toLowerCase() as DashboardReading["gasolina_estado"] | undefined)
            ?? (percent === 0 ? "vacio" : percent <= 15 ? "reserva" : percent <= 30 ? "bajo" : percent <= 70 ? "medio" : percent < 100 ? "alto" : "lleno");
        }
        break;
      }
      case "Galones": if (number === null) errors.push("Galones debe ser un número positivo."); else updatedInvoice.galones = number; break;
      case "Cantidad": if (number === null) errors.push("Cantidad debe ser un número positivo."); else updatedInvoice.cantidad = number; break;
      case "Valor de la Recarga": if (number === null) errors.push("Valor de la Recarga debe ser un número positivo."); else updatedInvoice.valor_recarga = number; break;
      case "Precio por Galón": if (number === null) errors.push("Precio por Galón debe ser un número positivo."); else updatedInvoice.precio_por_galon = number; break;
      case "SUBTOTAL": if (number === null) errors.push("SUBTOTAL debe ser un número mayor o igual a cero."); else updatedInvoice.subtotal = number; break;
      case "IVA": if (number === null) errors.push("IVA debe ser un número mayor o igual a cero."); else updatedInvoice.iva = number; break;
      case "Tipo de Combustible": updatedInvoice.tipo_combustible = value; break;
      case "PLACA": updatedInvoice.placa = value; break;
      case "RUC ESTACIÓN": updatedInvoice.ruc_estacion = value; break;
      case "ESTACIÓN DE SERVICIO": updatedInvoice.estacion_servicio = value; break;
      case "FECHA FACTURA": if (!validDate(value)) errors.push("FECHA FACTURA debe tener formato YYYY-MM-DD."); else updatedInvoice.fecha_factura = value; break;
      case "HORA FACTURA": if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) errors.push("HORA FACTURA debe tener formato HH:mm."); else updatedInvoice.hora_factura = value; break;
    }
  }
  if (errors.length) return { ok: false, errors };
  if (camposFacturaFaltantes(updatedInvoice).length || updatedReading.kilometraje_km === null || updatedReading.gasolina_porcentaje_aproximado === null) {
    return { ok: false, errors: ["Faltan campos válidos; envíalos de nuevo en un solo mensaje."] };
  }
  return { ok: true, reading: updatedReading, invoice: updatedInvoice };
}
