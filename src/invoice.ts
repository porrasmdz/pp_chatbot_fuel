import { analyzePhoto } from "./vision.js";

export type InvoiceReading = {
  es_factura: boolean;
  galones: number | null;
  cantidad: number | null;
  valor_recarga: number | null;
  tipo_combustible: string | null;
  precio_por_galon: number | null;
  fecha_factura: string | null;
  hora_factura: string | null;
};

export function facturaLegible(invoice: InvoiceReading): boolean {
  return invoice.es_factura && (invoice.galones !== null || invoice.valor_recarga !== null);
}

export async function analyzeInvoice(bytes: Buffer, mime: string): Promise<InvoiceReading> {
  const invoice = await analyzePhoto<InvoiceReading>(
    bytes,
    mime,
    "lectura_factura_combustible",
    "Lee únicamente la factura o comprobante de recarga de combustible de esta foto. No inventes datos ni calcules campos faltantes. Si no es una factura de combustible, es_factura debe ser false y todos los demás campos null. Extrae galones, el campo impreso Cantidad si aparece, el valor total de la recarga, el tipo de combustible y el precio por galón. Cantidad es un campo independiente: no lo copies de galones ni del valor si no aparece con ese nombre. Los números no deben incluir símbolos monetarios ni separadores de miles. Usa null si un campo no aparece o no se lee con claridad. Fecha en formato YYYY-MM-DD y hora en HH:mm (24 horas), únicamente cuando estén impresas y se puedan interpretar sin ambigüedad. No uses la fecha u hora actual.",
    "Extrae los datos de esta factura de combustible.",
    {
      type: "object",
      properties: {
        es_factura: { type: "boolean" },
        galones: { type: ["number", "null"] },
        cantidad: { type: ["number", "null"] },
        valor_recarga: { type: ["number", "null"] },
        tipo_combustible: { type: ["string", "null"] },
        precio_por_galon: { type: ["number", "null"] },
        fecha_factura: { type: ["string", "null"], description: "YYYY-MM-DD si la fecha impresa es legible" },
        hora_factura: { type: ["string", "null"], description: "HH:mm en 24 horas si la hora impresa es legible" },
      },
      required: ["es_factura", "galones", "cantidad", "valor_recarga", "tipo_combustible", "precio_por_galon", "fecha_factura", "hora_factura"],
      additionalProperties: false,
    },
  );
  if (typeof invoice.es_factura !== "boolean") throw new Error("Respuesta de factura inválida");
  for (const key of ["galones", "cantidad", "valor_recarga", "precio_por_galon"] as const) {
    const value = invoice[key];
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new Error(`Valor inválido en factura: ${key}`);
  }
  if (invoice.tipo_combustible !== null && typeof invoice.tipo_combustible !== "string") throw new Error("Tipo de combustible inválido");
  if (invoice.fecha_factura !== null && (typeof invoice.fecha_factura !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(invoice.fecha_factura))) throw new Error("Fecha de factura inválida");
  if (invoice.hora_factura !== null && (typeof invoice.hora_factura !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(invoice.hora_factura))) throw new Error("Hora de factura inválida");
  return invoice;
}
