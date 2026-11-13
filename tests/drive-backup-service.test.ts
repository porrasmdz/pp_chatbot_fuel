import assert from "node:assert/strict";
import { test } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { DriveBackupService, filePrefix, jpegBytes, safeFolderName } from "../src/drive-backup-service.ts";

function picture(mime: "image/jpeg" | "image/png" = "image/jpeg") {
  const canvas = createCanvas(40, 20);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff"; context.fillRect(0, 0, 40, 20);
  context.fillStyle = "#111111"; context.fillText("123", 2, 14);
  return { buffer: mime === "image/jpeg" ? canvas.toBuffer("image/jpeg", 92) : canvas.toBuffer("image/png"), mimeType: mime };
}

function fakeDrive() {
  const entries: Array<Record<string, any>> = [];
  let sequence = 0;
  let uploaded = 0;
  let failKm = false;
  let failNextList = false;
  const api = { files: {
    list: async ({ q }: { q: string }) => {
      if (failNextList) { failNextList = false; throw Object.assign(new Error("429"), { response: { status: 429 } }); }
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      let files = entries.filter(entry => entry.parents?.includes(parent));
      const name = /name = '([^']+)'/.exec(q)?.[1];
      if (name) files = files.filter(entry => entry.name === name);
      if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) files = files.filter(entry => entry.mimeType === "application/vnd.google-apps.folder");
      const recordId = /value='([^']+)'/.exec(q)?.[1];
      if (recordId) files = files.filter(entry => entry.appProperties?.globalCropsRecordId === recordId);
      return { data: { files } };
    },
    create: async ({ requestBody, media }: { requestBody: Record<string, any>; media?: { body: AsyncIterable<Buffer> } }) => {
      if (failKm && requestBody.appProperties?.globalCropsPhotoRole === "kilometraje") {
        throw Object.assign(new Error("Drive temporal"), { response: { status: 503 } });
      }
      if (media) {
        const chunks: Buffer[] = [];
        for await (const chunk of media.body) chunks.push(chunk);
        assert.equal(Buffer.concat(chunks).subarray(0, 2).toString("hex"), "ffd8");
        uploaded++;
      }
      const entry = { ...requestBody, id: `id-${++sequence}`, capabilities: { canAddChildren: true },
        webViewLink: `https://drive.google.com/file/d/id-${sequence}/view` };
      entries.push(entry);
      return { data: entry };
    },
    get: async ({ fileId }: { fileId: string }) => ({ data: entries.find(entry => entry.id === fileId) }),
  } };
  return { api, entries, uploads: () => uploaded, failKilometraje: (value: boolean) => { failKm = value; }, failListOnce: () => { failNextList = true; } };
}

const input = (idRegistro = "GSH1234_2026-11-13_12-00-00_abc123") => ({
  idRegistro, placa: "GSH1234", empleado: "Andrés Porras", fecha: "2026-11-13", hora: "12:00:00",
  factura: picture(), kilometraje: picture("image/png"),
});

test("normaliza carpeta, fecha y convierte PNG a JPEG real", async () => {
  assert.equal(safeFolderName("gsh 1234", "Andrés / Porras"), "GSH1234_ANDRES PORRAS");
  assert.equal(filePrefix("2026-11-13", "12:00:00"), "2026-11-13_12-00-00");
  assert.throws(() => filePrefix("2026-02-30", "12:00:00"), /inválida/);
  const jpeg = picture();
  assert.strictEqual(await jpegBytes(jpeg), jpeg.buffer);
  const converted = await jpegBytes(picture("image/png"));
  assert.equal(converted.subarray(0, 2).toString("hex"), "ffd8");
  assert.notEqual(converted.subarray(0, 4).toString("hex"), "89504e47");
});

test("crea una carpeta y exactamente dos archivos, luego los reutiliza", async () => {
  const drive = fakeDrive();
  const service = new DriveBackupService(drive.api as any, "root-1", async () => {});
  const first = await service.respaldarRepostaje(input());
  assert.equal(first.estado, "COMPLETO");
  assert.equal(first.carpeta?.nombre, "GSH1234_ANDRES PORRAS");
  assert.equal(first.archivos.factura?.nombre, "2026-11-13_12-00-00_factura.jpg");
  assert.equal(first.archivos.kilometraje?.nombre, "2026-11-13_12-00-00_kilometraje.jpg");
  const second = await service.respaldarRepostaje(input());
  assert.equal(second.estado, "COMPLETO");
  assert.equal(second.archivos.factura?.id, first.archivos.factura?.id);
  assert.equal(second.archivos.kilometraje?.id, first.archivos.kilometraje?.id);
  assert.equal(drive.entries.filter(entry => entry.mimeType === "application/vnd.google-apps.folder").length, 1);
  assert.equal(drive.uploads(), 2);
});

test("un respaldo parcial conserva la factura y solo sube el kilometraje al reintentar", async () => {
  const drive = fakeDrive();
  const service = new DriveBackupService(drive.api as any, "root-1", async () => {});
  drive.failKilometraje(true);
  const partial = await service.respaldarRepostaje(input());
  assert.equal(partial.estado, "PARCIAL");
  assert.equal(partial.reintentar, true);
  assert.ok(partial.archivos.factura?.id);
  assert.equal(partial.archivos.kilometraje, null);
  drive.failKilometraje(false);
  const complete = await service.respaldarRepostaje(input());
  assert.equal(complete.estado, "COMPLETO");
  assert.equal(complete.archivos.factura?.id, partial.archivos.factura?.id);
  assert.equal(drive.uploads(), 2);
});

test("distingue repostajes con el mismo segundo y reintenta HTTP 429", async () => {
  const drive = fakeDrive();
  let waits = 0;
  const service = new DriveBackupService(drive.api as any, "root-1", async () => { waits++; });
  drive.failListOnce();
  const first = await service.respaldarRepostaje(input());
  const second = await service.respaldarRepostaje(input("GSH1234_2026-11-13_12-00-00_def456"));
  assert.equal(first.estado, "COMPLETO");
  assert.equal(second.estado, "COMPLETO");
  assert.notEqual(second.archivos.factura?.nombre, first.archivos.factura?.nombre);
  assert.ok(waits >= 1);
  assert.equal(drive.uploads(), 4);
});

test("no insiste ante un error permanente de permisos", async () => {
  let calls = 0;
  const api = { files: { list: async () => {
    calls++;
    throw Object.assign(new Error("Sin permiso"), { response: { status: 403 } });
  } } };
  const service = new DriveBackupService(api as any, "root-1", async () => { throw new Error("No debe esperar"); });
  const output = await service.respaldarRepostaje(input());
  assert.equal(output.estado, "FALLIDO");
  assert.equal(output.reintentar, false);
  assert.equal(calls, 1);
});
