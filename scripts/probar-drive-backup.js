import { createCanvas } from "@napi-rs/canvas";
import { existsSync } from "node:fs";
import { DriveBackupService } from "../dist/drive-backup-service.js";

if (process.argv.slice(2).join(" ") !== "--real-upload") {
  console.error("Esta prueba crea dos imágenes ficticias en Google Drive. Para autorizarla explícitamente usa --real-upload.");
  process.exitCode = 2;
} else {
  if (existsSync(".env")) process.loadEnvFile(".env");
  try {
    const now = new Date();
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Guayaquil", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(now).map(part => [part.type, part.value]));
    const fecha = `${parts.year}-${parts.month}-${parts.day}`;
    const hora = `${parts.hour}:${parts.minute}:${parts.second}`;
    const picture = label => {
      const canvas = createCanvas(800, 400);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, 800, 400);
      ctx.fillStyle = "#111111"; ctx.font = "36px sans-serif";
      ctx.fillText(`PRUEBA FICTICIA - ${label}`, 35, 110);
      ctx.fillText(`${fecha} ${hora}`, 35, 180);
      return { buffer: canvas.toBuffer("image/jpeg", 92), mimeType: "image/jpeg" };
    };
    const service = await DriveBackupService.fromEnv();
    const idRegistro = `TEST001_${fecha}_${hora.replaceAll(":", "-")}_INTEGRACION`;
    const input = { idRegistro, placa: "TEST001", empleado: "USUARIO PRUEBA", fecha, hora,
      factura: picture("FACTURA"), kilometraje: picture("KILOMETRAJE") };
    const first = await service.respaldarRepostaje(input);
    const second = await service.respaldarRepostaje(input);
    if (!first.exito || !second.exito || first.archivos.factura?.id !== second.archivos.factura?.id
      || first.archivos.kilometraje?.id !== second.archivos.kilometraje?.id) {
      throw new Error("No se confirmó el respaldo completo e idempotente de ambas fotos ficticias.");
    }
    console.log(JSON.stringify({ idRegistro, carpeta: first.carpeta,
      factura: first.archivos.factura, kilometraje: first.archivos.kilometraje, sinDuplicados: true }, null, 2));
  } catch (error) {
    console.error("Falló la prueba de integración Drive:", error instanceof Error ? error.message : "error desconocido");
    process.exitCode = 1;
  }
}
