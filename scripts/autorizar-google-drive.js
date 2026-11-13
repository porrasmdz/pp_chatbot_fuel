import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { google } from "googleapis";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DEFAULT_REDIRECT_URI = "http://localhost:3000/oauth2callback";
const DEFAULT_TOKEN_PATH = "./keys/google-drive-token.json";
const OAUTH_CONFIG_PATH = "./keys/google-drive-oauth.json";
const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;

export function validateRedirectUri(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("GOOGLE_DRIVE_REDIRECT_URI no es una URL válida"); }
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname)
    || url.port !== "3000" || url.pathname !== "/oauth2callback"
    || url.search || url.hash || url.username || url.password) {
    throw new Error("GOOGLE_DRIVE_REDIRECT_URI debe ser exactamente http://localhost:3000/oauth2callback (o 127.0.0.1 si así está registrado)");
  }
  return url;
}

export function tokenToSave(tokens, previous, clientId) {
  const refreshToken = tokens.refresh_token || previous?.refresh_token;
  if (!refreshToken) throw new Error("Google no entregó un refresh_token. Vuelve a autorizar con --force y comprueba la pantalla de consentimiento.");
  const scope = tokens.scope || previous?.scope || DRIVE_SCOPE;
  if (!scope.split(/\s+/).includes(DRIVE_SCOPE)) throw new Error("La cuenta no concedió el permiso drive.file.");
  return { refresh_token: refreshToken, scope, client_id: clientId };
}

async function loadOAuthClient(env) {
  const envId = env.GOOGLE_DRIVE_CLIENT_ID?.trim();
  const envSecret = env.GOOGLE_DRIVE_CLIENT_SECRET?.trim();
  let clientId;
  let clientSecret;
  let registeredUris;
  if (envId || envSecret) {
    if (!envId || !envSecret) throw new Error("Configura GOOGLE_DRIVE_CLIENT_ID y GOOGLE_DRIVE_CLIENT_SECRET juntos.");
    clientId = envId;
    clientSecret = envSecret;
  } else {
    let config;
    try { config = JSON.parse(await readFile(OAUTH_CONFIG_PATH, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") throw new Error("Faltan GOOGLE_DRIVE_CLIENT_ID y GOOGLE_DRIVE_CLIENT_SECRET o keys/google-drive-oauth.json.");
      throw new Error("No se pudo leer keys/google-drive-oauth.json; revisa que sea un JSON válido y accesible.");
    }
    if (!config.web?.client_id || !config.web?.client_secret) {
      throw new Error("keys/google-drive-oauth.json debe contener un cliente OAuth de tipo web.");
    }
    clientId = config.web.client_id;
    clientSecret = config.web.client_secret;
    registeredUris = config.web.redirect_uris;
  }
  const redirectUri = env.GOOGLE_DRIVE_REDIRECT_URI?.trim() || DEFAULT_REDIRECT_URI;
  const redirect = validateRedirectUri(redirectUri);
  if (Array.isArray(registeredUris) && registeredUris.length && !registeredUris.includes(redirectUri)) {
    throw new Error("La URI configurada no figura en redirect_uris del cliente OAuth. Debe coincidir exactamente con Google Cloud Console.");
  }
  return { clientId, clientSecret, redirectUri, redirect };
}

export async function loadToken(path, clientId) {
  let token;
  try { token = JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`El archivo de tokens no se pudo leer o está corrupto: ${path}`);
  }
  if (token?.type === "service_account" || token?.web || token?.installed) {
    const error = new Error("GOOGLE_DRIVE_TOKEN_PATH apunta a credenciales de Google y no a un archivo de refresh token. No se modificó ese archivo.");
    error.protectedCredential = true;
    throw error;
  }
  if (!token || typeof token.refresh_token !== "string" || !token.refresh_token.trim()) {
    throw new Error(`El archivo de tokens no contiene un refresh_token válido: ${path}`);
  }
  if (token.client_id && token.client_id !== clientId) {
    throw new Error("El token guardado pertenece a otro cliente OAuth. Revisa las credenciales antes de autorizar de nuevo.");
  }
  return token;
}

export async function saveToken(path, token) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    try { await chmod(path, 0o600); }
    catch (error) { if (process.platform !== "win32") throw error; }
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw new Error(`No se pudo guardar el token en ${path}: ${error.code || "error de permisos"}`);
  }
}

function openBrowser(url) {
  const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => console.log("No se pudo abrir el navegador automáticamente; usa la URL anterior."));
    child.unref();
  } catch {
    console.log("No se pudo abrir el navegador automáticamente; usa la URL anterior.");
  }
}

export function sameState(received, expected) {
  if (!received) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function getAuthorizationCode(redirect, authUrl, expectedState) {
  let resolveCode;
  let rejectCode;
  const callback = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  const server = createServer((request, response) => {
    response.setHeader("Connection", "close");
    const incoming = new URL(request.url || "/", redirect);
    if (incoming.pathname !== "/oauth2callback") { response.writeHead(404); response.end("Ruta no encontrada."); return; }
    if (request.method !== "GET") { response.writeHead(405); response.end("Método no permitido."); return; }
    if (!sameState(incoming.searchParams.get("state"), expectedState)) {
      response.writeHead(400); response.end("Estado OAuth inválido. Vuelve a ejecutar el script.");
      rejectCode(new Error("La respuesta OAuth tiene un state inválido."));
      return;
    }
    if (incoming.searchParams.has("error")) {
      response.writeHead(400); response.end("La autorización fue rechazada. Puedes cerrar esta ventana.");
      rejectCode(new Error("La cuenta rechazó la autorización de Google Drive."));
      return;
    }
    const code = incoming.searchParams.get("code");
    if (!code) {
      response.writeHead(400); response.end("Falta el código OAuth.");
      rejectCode(new Error("Google no devolvió un código de autorización."));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Autorización recibida. Ya puedes cerrar esta ventana.");
    resolveCode(code);
  });

  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(3000, redirect.hostname, resolveListen);
    });
  } catch (error) {
    if (error.code === "EADDRINUSE") throw new Error("El puerto 3000 ya está ocupado. Cierra el proceso que lo usa y vuelve a ejecutar el script.");
    throw new Error(`No se pudo abrir el callback local: ${error.code || "error de red"}`);
  }

  let timer;
  try {
    console.log(`URI de redirección: ${redirect.href}`);
    console.log("Debe coincidir exactamente con la URI autorizada en Google Cloud Console.");
    console.log(`Abre esta URL para autorizar tu cuenta de Google:\n${authUrl}`);
    openBrowser(authUrl);
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Se agotaron 10 minutos esperando la autorización. Revisa también la URI de redirección registrada.")), CALLBACK_TIMEOUT_MS);
    });
    return await Promise.race([callback, timeout]);
  } finally {
    clearTimeout(timer);
    await new Promise(resolveClose => server.close(resolveClose));
  }
}

function errorCode(error) {
  return String(error?.response?.data?.error || error?.code || "");
}

async function verifyAccess(auth, rootFolderId) {
  try {
    const token = await auth.getAccessToken();
    if (!token.token) throw new Error("access_token ausente");
    console.log("Autenticación OAuth: correcta; se obtuvo un access token con el refresh token.");
  } catch (error) {
    const code = errorCode(error);
    if (code === "invalid_grant") throw new Error("El refresh token fue revocado o caducó. Ejecuta el script con --force para autorizar de nuevo.");
    if (code === "invalid_client") throw new Error("El Client ID o Client Secret es inválido. Revisa las credenciales OAuth.");
    throw new Error(`No se pudo renovar el access token (${code || "red o autenticación"}).`);
  }

  const drive = google.drive({ version: "v3", auth });
  try {
    await drive.files.list({ pageSize: 1, fields: "files(id)" });
    console.log("Google Drive API: acceso correcto.");
  } catch (error) {
    const code = errorCode(error);
    throw new Error(`Autenticación OAuth correcta, pero Drive API rechazó la consulta (${code || error?.response?.status || "red"}). Revisa que la API esté habilitada y que se concediera drive.file.`);
  }

  try {
    const response = await drive.files.get({
      fileId: rootFolderId, fields: "id,mimeType,trashed,capabilities(canAddChildren)", supportsAllDrives: true,
    });
    const folder = response.data;
    if (folder.mimeType !== "application/vnd.google-apps.folder" || folder.trashed) {
      throw new Error("La ID indicada no corresponde a una carpeta activa de Drive.");
    }
    console.log("Carpeta raíz: acceso de lectura correcto.");
    if (folder.capabilities?.canAddChildren !== true) {
      throw new Error("La carpeta es visible, pero la cuenta no tiene permiso para crear archivos dentro de ella.");
    }
    console.log("Carpeta raíz: permiso para agregar archivos confirmado.");
  } catch (error) {
    if (error.message?.startsWith("La ID indicada") || error.message?.startsWith("La carpeta es visible")) throw error;
    const status = error?.response?.status || error?.code;
    if (status === 403 || status === 404) {
      throw new Error("OAuth y Drive API funcionan, pero la carpeta raíz no es accesible con drive.file. Una carpeta creada manualmente puede requerir selección mediante Google Picker; también puedes crear una raíz administrada por la app. No se solicitaron permisos más amplios.");
    }
    throw new Error(`OAuth y Drive API funcionan, pero no se pudo verificar la carpeta raíz (${status || "red"}).`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Uso: node scripts/autorizar-google-drive.js [--force]");
    return;
  }
  if (args.some(arg => arg !== "--force")) throw new Error("Argumento desconocido. Usa --force o --help.");
  const force = args.includes("--force");
  if (existsSync(".env")) process.loadEnvFile(".env");
  const config = await loadOAuthClient(process.env);
  const rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID?.trim();
  if (!rootFolderId) throw new Error("Configura GOOGLE_DRIVE_ROOT_FOLDER_ID para verificar la carpeta raíz sin escribir en ella.");
  const tokenPath = resolve(process.env.GOOGLE_DRIVE_TOKEN_PATH?.trim() || DEFAULT_TOKEN_PATH);
  if (extname(tokenPath).toLowerCase() !== ".json") {
    throw new Error("GOOGLE_DRIVE_TOKEN_PATH debe apuntar a un archivo .json distinto de .env y de las credenciales de Sheets.");
  }
  const protectedPaths = [resolve(OAUTH_CONFIG_PATH), resolve("./keys/gcloud-keys.json")];
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
    protectedPaths.push(resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS.trim()));
  }
  if (protectedPaths.includes(tokenPath)) {
    throw new Error("GOOGLE_DRIVE_TOKEN_PATH coincide con credenciales existentes. Elige otro archivo; no se modificó ninguna credencial.");
  }
  console.log("Si la pantalla de consentimiento es Externa y está en Testing, el refresh token de Drive puede caducar a los 7 días. Revisa Google Auth Platform > Audience y publica la app para uso continuo.");
  const auth = new google.auth.OAuth2(config.clientId, config.clientSecret, config.redirectUri);
  let previous;
  try { previous = await loadToken(tokenPath, config.clientId); }
  catch (error) {
    if (!force || error.protectedCredential) throw error;
    console.log("El token guardado no se puede reutilizar. Se iniciará una autorización nueva.");
    previous = null;
  }

  if (previous && !force) {
    auth.setCredentials({ refresh_token: previous.refresh_token });
    await verifyAccess(auth, rootFolderId);
    console.log("Se reutilizó el refresh token existente. No fue necesario abrir el navegador.");
    return;
  }

  const state = randomBytes(32).toString("base64url");
  const authUrl = auth.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: [DRIVE_SCOPE], state });
  const code = await getAuthorizationCode(config.redirect, authUrl, state);
  let tokens;
  try { ({ tokens } = await auth.getToken(code)); }
  catch (error) {
    const code = errorCode(error);
    throw new Error(`No se pudo intercambiar el código OAuth (${code || "código inválido, red o redirect URI incorrecta"}).`);
  }
  const saved = tokenToSave(tokens, previous, config.clientId);
  auth.setCredentials({ refresh_token: saved.refresh_token });
  try {
    const access = await auth.getAccessToken();
    if (!access.token) throw new Error("No se obtuvo access token");
  } catch (error) {
    throw new Error(`El refresh token recibido no se pudo verificar (${errorCode(error) || "red o autenticación"}).`);
  }
  if (tokens.refresh_token || !previous) {
    await saveToken(tokenPath, saved);
    console.log(`Refresh token guardado en ${tokenPath}.`);
  } else {
    console.log("Google no entregó un refresh token nuevo; se conservó el existente.");
  }
  await verifyAccess(auth, rootFolderId);
  console.log("Autorización de Google Drive terminada. El servidor local se cerró.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
