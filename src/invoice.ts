import { analyzePhoto } from "./vision.js";

export type InvoiceReading = {
  es_factura: boolean;
  nitidez_pct: number;
  confianza_lectura_pct: number;
  galones: number | null;
  cantidad: number | null;
  valor_recarga: number | null;
  tipo_combustible: string | null;
  precio_por_galon: number | null;
  placa: string | null;
  ruc_estacion: string | null;
  estacion_servicio: string | null;
  numero_factura: string | null;
  fecha_factura: string | null;
  hora_factura: string | null;
  subtotal: number | null;
  iva: number | null;
};

function validInvoiceDate(value: string | null): boolean {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function camposFacturaFaltantes(invoice: InvoiceReading): string[] {
  const missing: string[] = [];
  if (invoice.galones === null || invoice.galones <= 0) missing.push("Galones");
  if (invoice.cantidad === null || invoice.cantidad <= 0) missing.push("Cantidad");
  if (invoice.valor_recarga === null || invoice.valor_recarga <= 0) missing.push("Valor de la Recarga");
  if (invoice.precio_por_galon === null || invoice.precio_por_galon <= 0) missing.push("Precio por Galón");
  for (const [value, name] of [
    [invoice.tipo_combustible, "Tipo de Combustible"],
    [invoice.placa, "PLACA"],
    [invoice.ruc_estacion, "RUC ESTACIÓN"],
    [invoice.estacion_servicio, "ESTACIÓN DE SERVICIO"],
  ] as const) {
    if (!value?.trim()) missing.push(name);
  }
  if (!validInvoiceDate(invoice.fecha_factura)) missing.push("FECHA FACTURA");
  if (!invoice.hora_factura || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(invoice.hora_factura)) missing.push("HORA FACTURA");
  if (invoice.subtotal === null || invoice.subtotal < 0) missing.push("SUBTOTAL");
  if (invoice.iva === null || invoice.iva < 0) missing.push("IVA");
  return missing;
}

export function facturaLegible(invoice: InvoiceReading): boolean {
  return invoice.es_factura
    && invoice.nitidez_pct >= 30
    && invoice.confianza_lectura_pct >= 30
    && camposFacturaFaltantes(invoice).length === 0;
}

export async function analyzeInvoice(bytes: Buffer, mime: string): Promise<InvoiceReading> {
  const invoice = await analyzePhoto<InvoiceReading>(
    bytes,
    mime,
    "lectura_factura_combustible",
    "Lee únicamente la factura o comprobante de recarga de combustible de esta foto. Da nitidez_pct de 0 a 100 según enfoque, iluminación y reflejos, y confianza_lectura_pct de 0 a 100 según la seguridad de la lectura de los campos obligatorios. Son estimaciones visuales, no probabilidades calibradas. No inventes datos ni calcules campos faltantes. Si no es una factura de combustible, es_factura debe ser false y todos los demás campos de factura null. Extrae galones, cantidad, valor total, tipo de combustible, precio por galón, placa, RUC de la estación, estación de servicio, número de factura, fecha y hora de emisión, subtotal e IVA. La cantidad puede aparecer como Cantidad, CANT., CTD, CND, CAN, CAM. o QTY. A veces la etiqueta se lee mal: busca un grupo de tres valores juntos donde la cantidad suele estar a la izquierda, seguida por VALOR y TOTAL. Si la estructura permite identificar con claridad el valor izquierdo, úsalo como cantidad aunque la etiqueta esté borrosa; si es ambiguo, usa null. No copies cantidad de galones, valor o total por simple suposición. El número de factura es opcional: usa null si no se distingue; no reduzcas la confianza general únicamente por ese campo. Conserva RUC, placa y número de factura como texto para no perder ceros iniciales. Los importes no deben incluir símbolos monetarios ni separadores de miles. IVA puede ser cero si la factura lo indica explícitamente. Usa null si otro campo no aparece o no se lee con claridad. Fecha en formato YYYY-MM-DD y hora en HH:mm (24 horas), únicamente cuando estén impresas y se puedan interpretar sin ambigüedad. No uses la fecha u hora actual ni la fecha de envío de WhatsApp.",
    "Extrae los datos de esta factura de combustible.",
    {
      type: "object",
      properties: {
        es_factura: { type: "boolean" },
        nitidez_pct: { type: "integer", description: "Nitidez visual de 0 a 100" },
        confianza_lectura_pct: { type: "integer", description: "Confianza visual en todos los campos de 0 a 100" },
        galones: { type: ["number", "null"] },
        cantidad: { type: ["number", "null"] },
        valor_recarga: { type: ["number", "null"] },
        tipo_combustible: { type: ["string", "null"] },
        precio_por_galon: { type: ["number", "null"] },
        placa: { type: ["string", "null"] },
        ruc_estacion: { type: ["string", "null"] },
        estacion_servicio: { type: ["string", "null"] },
        numero_factura: { type: ["string", "null"] },
        fecha_factura: { type: ["string", "null"], description: "YYYY-MM-DD si la fecha impresa es legible" },
        hora_factura: { type: ["string", "null"], description: "HH:mm en 24 horas si la hora impresa es legible" },
        subtotal: { type: ["number", "null"] },
        iva: { type: ["number", "null"] },
      },
      required: ["es_factura", "nitidez_pct", "confianza_lectura_pct", "galones", "cantidad", "valor_recarga", "tipo_combustible", "precio_por_galon", "placa", "ruc_estacion", "estacion_servicio", "numero_factura", "fecha_factura", "hora_factura", "subtotal", "iva"],
      additionalProperties: false,
    },
  );
  if (typeof invoice.es_factura !== "boolean") throw new Error("Respuesta de factura inválida");
  for (const key of ["nitidez_pct", "confianza_lectura_pct"] as const) {
    if (!Number.isInteger(invoice[key]) || invoice[key] < 0 || invoice[key] > 100) throw new Error(`Porcentaje inválido en factura: ${key}`);
  }
  for (const key of ["galones", "cantidad", "valor_recarga", "precio_por_galon", "subtotal", "iva"] as const) {
    const value = invoice[key];
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new Error(`Valor inválido en factura: ${key}`);
  }
  for (const key of ["tipo_combustible", "placa", "ruc_estacion", "estacion_servicio", "numero_factura"] as const) {
    if (invoice[key] !== null && typeof invoice[key] !== "string") throw new Error(`Texto inválido en factura: ${key}`);
  }
  if (invoice.fecha_factura !== null && (typeof invoice.fecha_factura !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(invoice.fecha_factura))) throw new Error("Fecha de factura inválida");
  if (invoice.hora_factura !== null && (typeof invoice.hora_factura !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(invoice.hora_factura))) throw new Error("Hora de factura inválida");
  return invoice;
}
