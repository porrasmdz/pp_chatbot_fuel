import type { DashboardReading } from "./analyze.js";
import { camposFacturaFaltantes, type InvoiceReading } from "./invoice.js";

export function invoiceIssues(invoice: InvoiceReading): string[] {
  const issues: string[] = [];
  if (invoice.nitidez_pct < 30) issues.push(`Foto poco clara: nitidez ${invoice.nitidez_pct}%`);
  if (invoice.confianza_lectura_pct < 30) issues.push(`Confianza ${invoice.confianza_lectura_pct}%`);
  for (const field of camposFacturaFaltantes(invoice)) issues.push(`No se ve ${field}`);
  return issues;
}

export function dashboardIssues(reading: DashboardReading): string[] {
  const issues: string[] = [];
  if (reading.nitidez_pct < 30) issues.push(`Foto poco clara: nitidez ${reading.nitidez_pct}%`);
  if (reading.confianza_lectura_pct < 30) issues.push(`Confianza ${reading.confianza_lectura_pct}%`);
  if (reading.kilometraje_km === null) issues.push("No se ve KILOMETRAJE. Repite la foto mostrando el kilometraje.");
  if (reading.confianza_kilometraje_pct !== null && reading.confianza_kilometraje_pct < 30) issues.push(`Confianza del KILOMETRAJE ${reading.confianza_kilometraje_pct}%`);
  if (reading.gasolina_estado === "no_legible" || reading.gasolina_porcentaje_aproximado === null) issues.push("No se ve COMBUSTIBLE. Repite la foto mostrando el nivel de combustible.");
  return issues;
}

export function validationMessage(invoiceErrors: string[], dashboardErrors: string[]): string {
  const sections: string[] = [];
  if (invoiceErrors.length) sections.push(`ERRORES FACTURA:\n${invoiceErrors.map(error => `🔴 ${error}`).join("\n")}`);
  if (dashboardErrors.length) sections.push(`ERRORES TABLERO:\n${dashboardErrors.map(error => `🔴 ${error}`).join("\n")}`);
  return sections.join("\n");
}
