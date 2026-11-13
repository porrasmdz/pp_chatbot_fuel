import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DriveBackupQueue, registrationSignature, stableRecordId } from "../src/drive-backup-queue.ts";
import { identifyPerson } from "../src/personas.ts";
import type { BackupResult } from "../src/drive-backup-service.ts";

const photo = { buffer: Buffer.from("foto ficticia"), mimeType: "image/png" };
const stageInput = (idRegistro: string) => ({
  idRegistro, phone: "0991234567", jid: "593991234567@s.whatsapp.net", claimedPlate: "GSH1234",
  fecha: "2026-11-13", hora: "12:00:00",
  signature: registrationSignature(["593991234567", 12000, "", "2026-11-13", "12:00:00", "", "", "", 27.4, "GSH1234", "", "", "FACT-1"]),
  factura: photo, kilometraje: photo,
});
const result = (id: string, estado: "COMPLETO" | "PARCIAL" | "FALLIDO", reintentar = true): BackupResult => ({
  exito: estado === "COMPLETO", estado, idRegistro: id,
  carpeta: { id: "folder", nombre: "GSH1234_ANDRES PORRAS" },
  archivos: { factura: { id: "factura", nombre: "factura.jpg", url: "https://drive.google.com/factura" },
    kilometraje: estado === "COMPLETO" ? { id: "km", nombre: "km.jpg", url: "https://drive.google.com/km" } : null },
  reintentar,
});

test("genera un ID estable desde los dos mensajes y relaciona teléfono y placa con Personas", () => {
  const first = stableRecordId("chat", "tablero", "factura", "GSH1234", "2026-11-13", "12:00:00");
  assert.equal(first, stableRecordId("chat", "tablero", "factura", "GSH1234", "2026-11-13", "12:00:00"));
  assert.notEqual(first, stableRecordId("otro-chat", "tablero", "factura", "GSH1234", "2026-11-13", "12:00:00"));
  const rows = [["TELF", "NOMBRE", "PLACA"], ["593991234567", "ANDRES PORRAS", "GSH1234"], ["593991234567", "ANDRES PORRAS", "ABC5678"]];
  assert.deepEqual(identifyPerson(rows, "0991234567", "chat", "gsh-1234"), { placa: "GSH1234", empleado: "ANDRES PORRAS" });
  assert.equal(identifyPerson(rows, "0991234567", "chat", "DESCONOCIDA"), null);
  assert.equal(identifyPerson(rows, "0980000000", "chat", "GSH1234"), null);
});

test("recupera fotos tras reinicio y borra las imágenes solo al completar", async () => {
  const dir = await mkdtemp(join(tmpdir(), "global-crops-backup-"));
  const id = stableRecordId("chat", "tablero", "factura", "GSH1234", "2026-11-13", "12:00:00");
  try {
    const firstProcess = new DriveBackupQueue(dir);
    assert.equal(await firstProcess.stage(stageInput(id)), "STAGED");
    const secondProcess = new DriveBackupQueue(dir);
    await secondProcess.init();
    assert.equal(await secondProcess.recoverRegistered(new Set([stageInput(id).signature])), 1);
    assert.equal((await secondProcess.get(id))?.status, "READY");
    let calls = 0;
    assert.equal(await secondProcess.runDue(async input => { calls++; assert.equal(input.factura.buffer.toString(), "foto ficticia"); return result(id, "PARCIAL"); }, 1000), 1);
    assert.equal((await secondProcess.get(id))?.attempts, 1);
    assert.equal(await secondProcess.runDue(async () => { calls++; return result(id, "COMPLETO"); }, 2000), 0);
    assert.equal(await secondProcess.runDue(async () => { calls++; return result(id, "COMPLETO"); }, 7000), 1);
    assert.equal(calls, 2);
    assert.equal(await secondProcess.isComplete(id), true);
    assert.equal(await secondProcess.get(id), null);
    assert.equal(await secondProcess.stage(stageInput(id)), "COMPLETE");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("bloquea errores permanentes hasta reintento explícito", async () => {
  const dir = await mkdtemp(join(tmpdir(), "global-crops-backup-"));
  const id = "registro-bloqueado";
  try {
    const queue = new DriveBackupQueue(dir);
    await queue.stage(stageInput(id));
    await queue.markReady(id);
    assert.equal(await queue.runDue(async () => result(id, "FALLIDO", false), 1000), 1);
    assert.equal((await queue.get(id))?.status, "BLOCKED");
    assert.equal(await queue.runDue(async () => result(id, "COMPLETO"), 999999), 0);
    assert.equal(await queue.resetBlocked(), 1);
    assert.equal(await queue.runDue(async () => result(id, "COMPLETO"), 999999), 1);
    assert.equal(await queue.isComplete(id), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
