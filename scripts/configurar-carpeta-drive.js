import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { google } from "googleapis";
import { DRIVE_SCOPE, loadOAuthClient, loadToken } from "./autorizar-google-drive.js";

const FOLDER_NAME = "Global Crops - Respaldos";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const APP_PROPERTY = "globalCropsBackupRoot";
const APP_PROPERTY_VALUE = "v1";
const ENV_KEY = "GOOGLE_DRIVE_ROOT_FOLDER_ID";
const DEFAULT_TOKEN_PATH = "./keys/google-drive-token.json";

export function updateEnvContent(content, folderId) {
  if (!/^[A-Za-z0-9_-]+$/.test(folderId)) throw new Error("La ID de carpeta recibida no es válida.");
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.match(/[^\r\n]*(?:\r\n|\n|$)/g)?.filter(Boolean) ?? [];
  const assignment = /^(\uFEFF?[ \t]*(?:export[ \t]+)?GOOGLE_DRIVE_ROOT_FOLDER_ID[ \t]*=[ \t]*)/;
  let found = false;
  let result = "";
  for (const line of lines) {
    const ending = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
    const body = line.slice(0, line.length - ending.length);
    const match = assignment.exec(body);
    if (!match) { result += line; continue; }
    if (found) continue;
    result += `${match[1]}${folderId}${ending}`;
    found = true;
  }
  if (!found) result += `${result && !result.endsWith("\n") ? newline : ""}${ENV_KEY}=${folderId}${newline}`;
  return result;
}

export async function saveRootFolderId(envPath, folderId) {
  let original = "";
  let mode = 0o600;
  try {
    original = await readFile(envPath, "utf8");
    mode = (await stat(envPath)).mode & 0o777;
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`No se pudo leer .env (${error.code || "error de permisos"}).`);
  }
  const updated = updateEnvContent(original, folderId);
  if (updated === original) return false;
  const temporary = `${envPath}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, updated, { mode, flag: "wx" });
    const latest = await readFile(envPath, "utf8").catch(error => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (latest !== original) throw new Error(".env cambió durante la actualización; vuelve a ejecutar el script.");
    await rename(temporary, envPath);
    if (process.platform !== "win32") await chmod(envPath, mode);
    return true;
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw new Error(`No se pudo actualizar .env: ${error.message || "error de permisos"}`);
  }
}

function isManagedRoot(folder) {
  return folder?.id && folder.name === FOLDER_NAME && folder.mimeType === FOLDER_MIME_TYPE
    && folder.trashed !== true && folder.appProperties?.[APP_PROPERTY] === APP_PROPERTY_VALUE;
}

async function verifyFolder(drive, folderId) {
  const folder = await getFolder(drive, folderId);
  if (!isManagedRoot(folder)) throw new Error("La carpeta encontrada no es la raíz administrada por esta aplicación.");
  if (folder.capabilities?.canAddChildren !== true) {
    throw new Error("La carpeta de la aplicación existe, pero no permite crear archivos dentro.");
  }
  return folder;
}

async function getFolder(drive, folderId) {
  const response = await drive.files.get({
    fileId: folderId,
    fields: "id,name,mimeType,trashed,parents,appProperties,capabilities(canAddChildren),webViewLink",
  });
  return response.data;
}

async function findManagedRoot(drive, configuredId) {
  if (configuredId) {
    try {
      const configured = await getFolder(drive, configuredId);
      if (isManagedRoot(configured)) {
        if (configured.capabilities?.canAddChildren !== true) {
          throw new Error("La carpeta de la aplicación existe, pero no permite crear archivos dentro.");
        }
        return configured;
      }
    } catch (error) {
      if (![403, 404].includes(Number(error?.response?.status || error?.code))) throw error;
    }
  }
  const query = `name = '${FOLDER_NAME}' and mimeType = '${FOLDER_MIME_TYPE}' and trashed = false and 'root' in parents and appProperties has { key='${APP_PROPERTY}' and value='${APP_PROPERTY_VALUE}' }`;
  let pageToken;
  const matches = [];
  do {
    const response = await drive.files.list({
      q: query, fields: "nextPageToken,files(id)", pageSize: 1000,
      ...(pageToken ? { pageToken } : {}),
    });
    matches.push(...(response.data.files ?? []).filter(file => file.id));
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);
  matches.sort((a, b) => (a.id === configuredId ? -1 : b.id === configuredId ? 1 : a.id.localeCompare(b.id)));
  let inaccessible = false;
  for (const match of matches) {
    try { return await verifyFolder(drive, match.id); }
    catch (error) {
      if ([403, 404].includes(Number(error?.response?.status || error?.code))) { inaccessible = true; continue; }
      throw error;
    }
  }
  if (inaccessible) throw new Error("Hay una carpeta de la aplicación, pero no se pudo consultar. No se creará otra hasta resolver el acceso.");
  return null;
}

export async function findOrCreateRoot(drive, configuredId) {
  const existing = await findManagedRoot(drive, configuredId);
  if (existing) return { folder: existing, created: false };
  const response = await drive.files.create({
    requestBody: {
      name: FOLDER_NAME, mimeType: FOLDER_MIME_TYPE, parents: ["root"],
      appProperties: { [APP_PROPERTY]: APP_PROPERTY_VALUE },
    },
    fields: "id",
  });
  const folderId = response.data.id;
  if (!folderId) throw new Error("Drive API creó la carpeta, pero no devolvió su ID. No se modificó .env.");
  console.log(`Carpeta creada en Mi unidad. ID: ${folderId}`);
  return { folder: await verifyFolder(drive, folderId), created: true };
}

async function main() {
  if (process.argv.length !== 2) throw new Error("Uso: node scripts/configurar-carpeta-drive.js");
  if (existsSync(".env")) process.loadEnvFile(".env");
  const config = await loadOAuthClient(process.env);
  const tokenPath = resolve(process.env.GOOGLE_DRIVE_TOKEN_PATH?.trim() || DEFAULT_TOKEN_PATH);
  const token = await loadToken(tokenPath, config.clientId);
  if (!token) throw new Error("Falta el refresh token. Ejecuta primero node scripts/autorizar-google-drive.js.");
  if (token.scope && !token.scope.split(/\s+/).includes(DRIVE_SCOPE)) {
    throw new Error("El token guardado no incluye drive.file. No se solicitarán permisos adicionales.");
  }
  const auth = new google.auth.OAuth2(config.clientId, config.clientSecret, config.redirectUri);
  auth.setCredentials({ refresh_token: token.refresh_token });
  try {
    const access = await auth.getAccessToken();
    if (!access.token) throw new Error("Access token ausente");
  } catch (error) {
    const code = error?.response?.data?.error || error?.code;
    if (code === "invalid_grant") throw new Error("El refresh token caducó o fue revocado. Reautoriza con --force antes de configurar la carpeta.");
    throw new Error(`No se pudo renovar el access token (${code || "red o autenticación"}).`);
  }
  const drive = google.drive({ version: "v3", auth });
  const configuredId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID?.trim() || null;
  let result;
  try { result = await findOrCreateRoot(drive, configuredId); }
  catch (error) {
    const status = error?.response?.status || error?.code;
    if (status === 403) throw new Error("Drive rechazó la operación con drive.file. Comprueba el acceso de la cuenta y la API habilitada.");
    throw error;
  }
  const envUpdated = await saveRootFolderId(resolve(".env"), result.folder.id);
  const link = result.folder.webViewLink || `https://drive.google.com/drive/folders/${result.folder.id}`;
  console.log(result.created ? "Nueva carpeta verificada por ID." : "Carpeta administrada por la aplicación reutilizada y verificada por ID.");
  console.log(`GOOGLE_DRIVE_ROOT_FOLDER_ID=${result.folder.id}`);
  console.log(`Enlace: ${link}`);
  console.log(envUpdated ? ".env actualizado sin cambiar las demás variables." : ".env ya tenía este ID; no se modificó.");
  console.log("No se modificó la carpeta manual.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
