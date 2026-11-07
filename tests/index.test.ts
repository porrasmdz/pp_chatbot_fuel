import assert from "node:assert/strict";
import { test } from "node:test";
import type { WAMessage } from "@whiskeysockets/baileys";
import { analyzeImage } from "../src/analyze.ts";
import { incomingImage } from "../src/index.ts";
import { analyzeInvoice, facturaLegible } from "../src/invoice.ts";
import { readingRow, SHEET_HEADERS } from "../src/sheets.ts";
import { facturaPocoClara, fotoPocoClara, lecturaConfiable, pedirFactura } from "../src/templates.ts";

test("reconoce fotos entrantes de chats privados", () => {
  const message = {
    key: { id: "ABC123", remoteJid: "593999999999@s.whatsapp.net", fromMe: false },
    message: { ephemeralMessage: { message: { imageMessage: { mimetype: "image/jpeg" } } } },
  } as WAMessage;
  assert.deepEqual(incomingImage(message), { id: "ABC123", mime: "image/jpeg", numeroUsuario: "593999999999", remitenteJid: "593999999999@s.whatsapp.net" });
  assert.equal(incomingImage({ ...message, key: { ...message.key, fromMe: true } }), null);
  assert.equal(incomingImage({ ...message, key: { ...message.key, remoteJid: "123@g.us" } }), null);
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
        ? { kilometraje_km: 189350, confianza_kilometraje_pct: 87, gasolina_estado: "reserva", gasolina_porcentaje_aproximado: 10, observaciones: "Visible" }
        : { es_factura: true, galones: 10, cantidad: 10, valor_recarga: 25, tipo_combustible: "Extra", precio_por_galon: 2.5, fecha_factura: "2026-10-11", hora_factura: "14:30" };
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

test("ordena las nueve columnas de Google Sheets", () => {
  assert.deepEqual(SHEET_HEADERS, ["TELF", "KILOMETRAJE", "COMBUSTIBLE", "FECHA", "HORA", "Precio por Galón", "Galones", "Tipo de Combustible", "Valor de la Recarga"]);
  assert.deepEqual(readingRow({
    phone: "593999999999",
    jid: "593999999999@s.whatsapp.net",
    reading: { kilometraje_km: 189350, confianza_kilometraje_pct: 87, gasolina_estado: "reserva", gasolina_porcentaje_aproximado: 10, observaciones: "Visible" },
    invoice: { es_factura: true, galones: 10, cantidad: 10, valor_recarga: 25, tipo_combustible: "Extra", precio_por_galon: 2.5, fecha_factura: "2026-10-11", hora_factura: "14:30" },
  }), ["593999999999", 189350, "reserva (10%)", "2026-10-11", "14:30", 2.5, 10, "Extra", 25]);
});

test("solicita factura solo con confianza mayor que 80", () => {
  const reading = { kilometraje_km: 189350, confianza_kilometraje_pct: 81, gasolina_estado: "reserva" as const, gasolina_porcentaje_aproximado: 10, observaciones: "Visible" };
  assert.equal(lecturaConfiable(reading), true);
  assert.equal(lecturaConfiable({ ...reading, confianza_kilometraje_pct: 80 }), false);
  assert.match(pedirFactura, /factura/);
  assert.match(fotoPocoClara, /kilometraje/);
  assert.match(facturaPocoClara, /factura/);
});
