import assert from "node:assert/strict";
import { test } from "node:test";
import type { WAMessage } from "@whiskeysockets/baileys";
import { analyzeImage } from "../src/analyze.ts";
import { incomingImage, whatsappSentAt } from "../src/index.ts";
import { analyzeInvoice, facturaLegible } from "../src/invoice.ts";
import { photoWarningRow, PHOTO_WARNING_HEADERS, readingRow, SHEET_HEADERS } from "../src/sheets.ts";
import { facturaPocoClara, fotoPocoClara, lecturaConfiable, pedirFactura } from "../src/templates.ts";
import { dashboardIssues, invoiceIssues, validationMessage } from "../src/validation.ts";

test("reconoce fotos entrantes de chats privados", () => {
  const message = {
    key: { id: "ABC123", remoteJid: "593999999999@s.whatsapp.net", fromMe: false },
    messageTimestamp: Date.parse("2026-10-11T02:00:00.000Z") / 1000,
    message: { ephemeralMessage: { message: { imageMessage: { mimetype: "image/jpeg" } } } },
  } as WAMessage;
  assert.deepEqual(incomingImage(message), { id: "ABC123", mime: "image/jpeg", numeroUsuario: "593999999999", remitenteJid: "593999999999@s.whatsapp.net" });
  assert.equal(incomingImage({ ...message, key: { ...message.key, fromMe: true } }), null);
  assert.equal(incomingImage({ ...message, key: { ...message.key, remoteJid: "123@g.us" } }), null);
  assert.equal(whatsappSentAt(message)?.toISOString(), "2026-10-11T02:00:00.000Z");
});

test("extrae tablero y factura con esquemas distintos", async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENROUTER_API_KEY;
  const previousModel = process.env.OPENROUTER_MODEL;
  process.env.OPENROUTER_API_KEY = "clave-de-prueba";
  process.env.OPENROUTER_MODEL = "modelo/de-prueba";
  try {
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.messages[1].content[1].image_url.url, "data:image/jpeg;base64,AQI=");
      const content = body.response_format.json_schema.name === "lectura_tablero"
        ? { nitidez_pct: 95, confianza_lectura_pct: 90, kilometraje_km: 189350, confianza_kilometraje_pct: 87, gasolina_estado: "reserva", gasolina_porcentaje_aproximado: 10, observaciones: "Visible" }
        : { es_factura: true, nitidez_pct: 95, confianza_lectura_pct: 90, galones: 10, cantidad: 10, valor_recarga: 25, tipo_combustible: "Extra", precio_por_galon: 2.5, placa: "ABC1234", ruc_estacion: "1234567890001", estacion_servicio: "Estación Centro", numero_factura: "001-001-000000123", fecha_factura: "2026-10-11", hora_factura: "14:30", subtotal: 22.32, iva: 2.68 };
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }] });
    };
    assert.equal((await analyzeImage(Buffer.from([1, 2]), "image/jpeg")).kilometraje_km, 189350);
    const invoice = await analyzeInvoice(Buffer.from([1, 2]), "image/jpeg");
    assert.equal(invoice.galones, 10);
    assert.equal(facturaLegible(invoice), true);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.OPENROUTER_MODEL;
    else process.env.OPENROUTER_MODEL = previousModel;
  }
});

test("ordena las diecisiete columnas según su origen", () => {
  assert.deepEqual(SHEET_HEADERS, ["TELF", "KILOMETRAJE", "COMBUSTIBLE", "FECHA", "HORA", "Precio por Galón", "Galones", "Tipo de Combustible", "Valor de la Recarga", "PLACA", "RUC ESTACIÓN", "ESTACIÓN DE SERVICIO", "NÚMERO DE FACTURA", "FECHA FACTURA", "HORA FACTURA", "SUBTOTAL", "IVA"]);
  assert.deepEqual(readingRow({
    phone: "593999999999",
    jid: "593999999999@s.whatsapp.net",
    sentAt: new Date("2026-10-11T02:00:00.000Z"),
    reading: { nitidez_pct: 95, confianza_lectura_pct: 90, kilometraje_km: 189350, confianza_kilometraje_pct: 87, gasolina_estado: "reserva", gasolina_porcentaje_aproximado: 10, observaciones: "Visible" },
    invoice: { es_factura: true, nitidez_pct: 95, confianza_lectura_pct: 90, galones: 10, cantidad: 10, valor_recarga: 25, tipo_combustible: "Extra", precio_por_galon: 2.5, placa: "ABC1234", ruc_estacion: "1234567890001", estacion_servicio: "Estación Centro", numero_factura: "001-001-000000123", fecha_factura: "2026-10-11", hora_factura: "14:30", subtotal: 22.32, iva: 2.68 },
  }), ["593999999999", 189350, "reserva (10%)", "2026-10-10", "21:00:00", 2.5, 10, "Extra", 25, "ABC1234", "1234567890001", "Estación Centro", "001-001-000000123", "2026-10-11", "14:30", 22.32, 2.68]);
});

test("valida campos, acepta nitidez y confianza desde 30", () => {
  const reading = { nitidez_pct: 80, confianza_lectura_pct: 80, kilometraje_km: 189350, confianza_kilometraje_pct: 80, gasolina_estado: "reserva" as const, gasolina_porcentaje_aproximado: 10, observaciones: "Visible" };
  assert.equal(lecturaConfiable(reading), true);
  assert.equal(lecturaConfiable({ ...reading, confianza_kilometraje_pct: 79 }), true);
  assert.equal(lecturaConfiable({ ...reading, confianza_kilometraje_pct: 29 }), false);
  assert.equal(lecturaConfiable({ ...reading, nitidez_pct: 79 }), true);
  assert.equal(lecturaConfiable({ ...reading, nitidez_pct: 30 }), true);
  assert.equal(lecturaConfiable({ ...reading, nitidez_pct: 29 }), false);
  assert.equal(lecturaConfiable({ ...reading, confianza_lectura_pct: 79 }), true);
  assert.equal(lecturaConfiable({ ...reading, confianza_lectura_pct: 29 }), false);
  assert.equal(lecturaConfiable({ ...reading, gasolina_estado: "no_legible", gasolina_porcentaje_aproximado: null }), false);
  const invoice = { es_factura: true, nitidez_pct: 80, confianza_lectura_pct: 80, galones: 10, cantidad: 10, valor_recarga: 25, tipo_combustible: "Extra", precio_por_galon: 2.5, placa: "ABC1234", ruc_estacion: "1234567890001", estacion_servicio: "Estación Centro", numero_factura: "001-001-000000123", fecha_factura: "2026-10-11", hora_factura: "14:30", subtotal: 22.32, iva: 2.68 };
  assert.equal(facturaLegible(invoice), true);
  assert.equal(facturaLegible({ ...invoice, nitidez_pct: 79 }), true);
  assert.equal(facturaLegible({ ...invoice, nitidez_pct: 30 }), true);
  assert.equal(facturaLegible({ ...invoice, nitidez_pct: 29 }), false);
  assert.equal(facturaLegible({ ...invoice, confianza_lectura_pct: 70 }), true);
  assert.equal(facturaLegible({ ...invoice, confianza_lectura_pct: 29 }), false);
  assert.equal(facturaLegible({ ...invoice, placa: null }), false);
  assert.equal(facturaLegible({ ...invoice, numero_factura: null }), true);
  assert.match(pedirFactura, /factura/);
  assert.match(fotoPocoClara, /kilometraje/);
  assert.match(facturaPocoClara, /factura/);
});

test("agrupa errores específicos con círculos rojos", () => {
  const invoice = { es_factura: true, nitidez_pct: 29, confianza_lectura_pct: 75, galones: null, cantidad: 10, valor_recarga: 25, tipo_combustible: "Extra", precio_por_galon: 2.5, placa: null, ruc_estacion: "1234567890001", estacion_servicio: "Estación Centro", numero_factura: "001-001-000000123", fecha_factura: "2026-10-11", hora_factura: "14:30", subtotal: 22.32, iva: 2.68 };
  const reading = { nitidez_pct: 29, confianza_lectura_pct: 80, kilometraje_km: null, confianza_kilometraje_pct: null, gasolina_estado: "no_legible" as const, gasolina_porcentaje_aproximado: null, observaciones: "Borrosa" };
  const text = validationMessage(invoiceIssues(invoice), dashboardIssues(reading));
  assert.match(text, /ERRORES FACTURA:\n🔴 Foto poco clara/);
  assert.match(text, /🔴 No se ve Galones/);
  assert.match(text, /🔴 No se ve PLACA/);
  assert.match(text, /ERRORES TABLERO:\n🔴 Foto poco clara/);
  assert.match(text, /🔴 No se ve KILOMETRAJE/);
  assert.equal(validationMessage([], ["No se ve COMBUSTIBLE"]), "ERRORES TABLERO:\n🔴 No se ve COMBUSTIBLE");
});

test("registra nitidez intermedia sin notificar al chat", () => {
  assert.deepEqual(PHOTO_WARNING_HEADERS, ["NITIDEZ (PORCENTAJE)", "FECHA (FECHA DE RECIIMIENTO)", "HORA (DE RECIBIMIENTO)", "TELF", "TIPO"]);
  assert.deepEqual(photoWarningRow({ nitidez: 55, receivedAt: Date.parse("2026-10-11T02:00:00.000Z"), phone: null, jid: "123@lid", tipo: "FACTURA" }), [55, "2026-10-10", "21:00:00", "123@lid", "FACTURA"]);
  assert.equal(photoWarningRow({ nitidez: 30, receivedAt: Date.parse("2026-10-11T02:00:00.000Z"), phone: null, jid: "123@lid", tipo: "TABLERO" })[0], 30);
  assert.deepEqual(photoWarningRow({ nitidez: 90, receivedAt: Date.parse("2026-10-11T02:00:00.000Z"), phone: null, jid: "123@lid", tipo: "FACTURA - NÚMERO DE FACTURA NO SE VE" }), [90, "2026-10-10", "21:00:00", "123@lid", "FACTURA - NÚMERO DE FACTURA NO SE VE"]);
  const invoice = { es_factura: true, nitidez_pct: 55, confianza_lectura_pct: 90, galones: 10, cantidad: 10, valor_recarga: 25, tipo_combustible: "Extra", precio_por_galon: 2.5, placa: "ABC1234", ruc_estacion: "1234567890001", estacion_servicio: "Estación Centro", numero_factura: "001-001-000000123", fecha_factura: "2026-10-11", hora_factura: "14:30", subtotal: 22.32, iva: 2.68 };
  assert.equal(facturaLegible(invoice), true);
  assert.deepEqual(invoiceIssues(invoice), []);
  assert.deepEqual(invoiceIssues({ ...invoice, nitidez_pct: 90, confianza_lectura_pct: 70 }), []);
  assert.deepEqual(dashboardIssues({ nitidez_pct: 55, confianza_lectura_pct: 70, kilometraje_km: 189350, confianza_kilometraje_pct: 70, gasolina_estado: "reserva", gasolina_porcentaje_aproximado: 10, observaciones: "Visible" }), []);
});
