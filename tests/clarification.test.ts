import assert from "node:assert/strict";
import { test } from "node:test";
import type { DashboardReading } from "../src/analyze.ts";
import { applyClarification, fieldsToClarify } from "../src/clarification.ts";
import type { InvoiceReading } from "../src/invoice.ts";
import { photoWarningRow } from "../src/sheets.ts";

const reading: DashboardReading = {
  nitidez_pct: 70, confianza_lectura_pct: 60,
  kilometraje_km: null, confianza_kilometraje_pct: null,
  gasolina_estado: "no_legible", gasolina_porcentaje_aproximado: null,
  observaciones: "Odómetro y combustible borrosos",
};
const invoice: InvoiceReading = {
  es_factura: true, nitidez_pct: 80, confianza_lectura_pct: 70,
  galones: 10, cantidad: 10, valor_recarga: 25, tipo_combustible: "Extra",
  precio_por_galon: 2.5, placa: null, ruc_estacion: "1234567890001",
  estacion_servicio: "Estación Centro", numero_factura: null,
  fecha_factura: "2026-11-13", hora_factura: "09:30", subtotal: 22.32, iva: 2.68,
};

test("solicita solo los campos obligatorios que faltan en las dos fotos", () => {
  assert.deepEqual(fieldsToClarify(reading, invoice), ["KILOMETRAJE", "COMBUSTIBLE", "PLACA"]);
});

test("valida un mensaje con varios campos y conserva los datos leídos", () => {
  const fields = fieldsToClarify(reading, invoice);
  const result = applyClarification(reading, invoice, fields, "KILOMETRAJE: 189350\nCOMBUSTIBLE: medio 50%\nPLACA: ABC1234");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.reading.kilometraje_km, 189350);
  assert.equal(result.reading.gasolina_porcentaje_aproximado, 50);
  assert.equal(result.reading.gasolina_estado, "medio");
  assert.equal(result.invoice.placa, "ABC1234");
  assert.equal(result.invoice.numero_factura, null);
  assert.equal(result.invoice.valor_recarga, 25);
});

test("rechaza aclaraciones incompletas, desconocidas o inválidas", () => {
  const fields = fieldsToClarify(reading, invoice);
  assert.equal(applyClarification(reading, invoice, fields, "KILOMETRAJE: 189350\nPLACA: ABC1234").ok, false);
  assert.equal(applyClarification(reading, invoice, fields, "KILOMETRAJE: 189350\nCOMBUSTIBLE: 150%\nPLACA: ABC1234").ok, false);
  assert.equal(applyClarification(reading, invoice, fields, "KILOMETRAJE: 189350\nCOMBUSTIBLE: medio 50%\nIVA: 0\nPLACA: ABC1234").ok, false);
});

test("acepta un valor sin etiqueta cuando solo se solicita un campo", () => {
  const validReading = { ...reading, kilometraje_km: 123, confianza_kilometraje_pct: 80, gasolina_estado: "medio" as const, gasolina_porcentaje_aproximado: 50 };
  const result = applyClarification(validReading, invoice, ["PLACA"], "ABC1234");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.invoice.placa, "ABC1234");
  const timeResult = applyClarification(validReading, { ...invoice, placa: "ABC1234", hora_factura: null }, ["HORA FACTURA"], "09:30");
  assert.equal(timeResult.ok, true);
  if (timeResult.ok) assert.equal(timeResult.invoice.hora_factura, "09:30");
});

test("la aclaración cabe en el registro existente de FOTOS_SIN_NITIDEZ", () => {
  const row = photoWarningRow({ nitidez: 80, receivedAt: Date.parse("2026-11-13T15:00:00Z"), phone: "593999999999", jid: "593999999999@s.whatsapp.net", tipo: "FACTURA - ACLARACIÓN DEL USUARIO: PLACA: ABC1234" });
  assert.equal(row[4], "FACTURA - ACLARACIÓN DEL USUARIO: PLACA: ABC1234");
});
