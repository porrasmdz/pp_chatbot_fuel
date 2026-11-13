import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findOrCreateRoot, saveRootFolderId, updateEnvContent } from "../scripts/configurar-carpeta-drive.js";

const folder = (id: string) => ({
  id, name: "Global Crops - Respaldos", mimeType: "application/vnd.google-apps.folder",
  trashed: false, appProperties: { globalCropsBackupRoot: "v1" },
  capabilities: { canAddChildren: true }, webViewLink: `https://drive.google.com/drive/folders/${id}`,
});

test("actualiza solo GOOGLE_DRIVE_ROOT_FOLDER_ID y elimina duplicados", () => {
  const original = "OPENROUTER_API_KEY=secreto\r\nGOOGLE_DRIVE_ROOT_FOLDER_ID=manual\r\n# comentario\r\nGOOGLE_DRIVE_ROOT_FOLDER_ID=duplicado\r\nGOOGLE_SHEET_NAME=Matriz\r\n";
  const updated = updateEnvContent(original, "raiz_app_123");
  assert.equal(updated, "OPENROUTER_API_KEY=secreto\r\nGOOGLE_DRIVE_ROOT_FOLDER_ID=raiz_app_123\r\n# comentario\r\nGOOGLE_SHEET_NAME=Matriz\r\n");
  assert.equal(updateEnvContent(updated, "raiz_app_123"), updated);
  assert.equal(updateEnvContent("A=1", "raiz_app_123"), "A=1\nGOOGLE_DRIVE_ROOT_FOLDER_ID=raiz_app_123\n");
  assert.throws(() => updateEnvContent(original, "id\nOTRA_CLAVE=2"), /ID de carpeta/);
});

test("reutiliza una carpeta administrada en Mi unidad sin crear otra", async () => {
  let creates = 0;
  const drive = { files: {
    list: async ({ q }: { q: string }) => {
      assert.match(q, /'root' in parents/);
      assert.match(q, /appProperties has/);
      return { data: { files: [{ id: "raiz_app_123" }] } };
    },
    get: async ({ fileId }: { fileId: string }) => ({ data: fileId === "carpeta_manual" ? { id: fileId, name: "Carpeta manual", mimeType: "application/vnd.google-apps.folder" } : folder(fileId) }),
    create: async () => { creates++; throw new Error("No debe crear otra carpeta"); },
  } };
  const result = await findOrCreateRoot(drive, "carpeta_manual");
  assert.equal(result.folder.id, "raiz_app_123");
  assert.equal(result.created, false);
  assert.equal(creates, 0);
});

test("consulta directamente el ID guardado antes del índice de búsqueda", async () => {
  let lists = 0;
  let creates = 0;
  const drive = { files: {
    get: async () => ({ data: folder("raiz_app_123") }),
    list: async () => { lists++; return { data: { files: [] } }; },
    create: async () => { creates++; return { data: { id: "otra" } }; },
  } };
  const result = await findOrCreateRoot(drive, "raiz_app_123");
  assert.equal(result.folder.id, "raiz_app_123");
  assert.equal(result.created, false);
  assert.equal(lists, 0);
  assert.equal(creates, 0);
});

test("crea la carpeta marcada en la raíz y verifica el ID devuelto", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const drive = { files: {
    list: async () => ({ data: { files: [] } }),
    create: async ({ requestBody: body }: { requestBody: Record<string, unknown> }) => {
      requestBody = body;
      return { data: { id: "nueva_raiz_456" } };
    },
    get: async ({ fileId }: { fileId: string }) => {
      if (fileId === "carpeta_manual") throw Object.assign(new Error("No accesible"), { response: { status: 404 } });
      return { data: folder(fileId) };
    },
  } };
  const result = await findOrCreateRoot(drive, "carpeta_manual");
  assert.equal(result.created, true);
  assert.equal(result.folder.id, "nueva_raiz_456");
  assert.deepEqual(requestBody?.parents, ["root"]);
  assert.deepEqual(requestBody?.appProperties, { globalCropsBackupRoot: "v1" });
});

test("rechaza una carpeta sin permiso de escritura y no crea otra", async () => {
  let creates = 0;
  const drive = { files: {
    list: async () => ({ data: { files: [{ id: "raiz_app_123" }] } }),
    get: async () => ({ data: { ...folder("raiz_app_123"), capabilities: { canAddChildren: false } } }),
    create: async () => { creates++; return { data: { id: "otra" } }; },
  } };
  await assert.rejects(findOrCreateRoot(drive, null), /no permite crear/);
  assert.equal(creates, 0);
});

test("guarda el ID en .env sin alterar las demás variables", async () => {
  const dir = await mkdtemp(join(tmpdir(), "global-crops-drive-folder-"));
  const path = join(dir, ".env");
  try {
    await writeFile(path, "GOOGLE_DRIVE_ROOT_FOLDER_ID=manual\nOPENROUTER_API_KEY=secreto\n");
    assert.equal(await saveRootFolderId(path, "raiz_app_123"), true);
    assert.equal(await readFile(path, "utf8"), "GOOGLE_DRIVE_ROOT_FOLDER_ID=raiz_app_123\nOPENROUTER_API_KEY=secreto\n");
    assert.equal(await saveRootFolderId(path, "raiz_app_123"), false);
    assert.equal(await readFile(path, "utf8"), "GOOGLE_DRIVE_ROOT_FOLDER_ID=raiz_app_123\nOPENROUTER_API_KEY=secreto\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
