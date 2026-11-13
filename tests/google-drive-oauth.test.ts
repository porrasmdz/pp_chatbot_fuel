import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DRIVE_SCOPE, loadToken, sameState, saveToken, tokenToSave, validateRedirectUri } from "../scripts/autorizar-google-drive.js";

test("acepta solo el callback OAuth local esperado", () => {
  assert.equal(validateRedirectUri("http://localhost:3000/oauth2callback").pathname, "/oauth2callback");
  assert.throws(() => validateRedirectUri("http://localhost:3001/oauth2callback"), /3000/);
  assert.throws(() => validateRedirectUri("https://localhost:3000/oauth2callback"), /3000/);
  assert.throws(() => validateRedirectUri("http://example.com:3000/oauth2callback"), /3000/);
  assert.throws(() => validateRedirectUri("http://localhost:3000/otra-ruta"), /3000/);
});

test("valida state antes de aceptar la respuesta OAuth", () => {
  assert.equal(sameState("estado-aleatorio", "estado-aleatorio"), true);
  assert.equal(sameState("estado-falso", "estado-aleatorio"), false);
  assert.equal(sameState(null, "estado-aleatorio"), false);
});

test("conserva el refresh token anterior cuando Google no entrega uno nuevo", () => {
  const previous = { refresh_token: "token-anterior", scope: DRIVE_SCOPE };
  assert.deepEqual(tokenToSave({ access_token: "temporal" }, previous, "cliente-1"), {
    refresh_token: "token-anterior", scope: DRIVE_SCOPE, client_id: "cliente-1",
  });
  assert.equal(tokenToSave({ refresh_token: "token-nuevo", scope: DRIVE_SCOPE }, previous, "cliente-1").refresh_token, "token-nuevo");
  assert.throws(() => tokenToSave({ access_token: "temporal" }, null, "cliente-1"), /refresh_token/);
  assert.throws(() => tokenToSave({ refresh_token: "token-nuevo", scope: "https://www.googleapis.com/auth/drive.metadata.readonly" }, null, "cliente-1"), /drive.file/);
});

test("guarda y reutiliza el token sin mezclarlo con credenciales de servicio", async () => {
  const dir = await mkdtemp(join(tmpdir(), "global-crops-drive-oauth-"));
  const path = join(dir, "keys", "google-drive-token.json");
  try {
    const credentials = { refresh_token: "token-ficticio", scope: DRIVE_SCOPE, client_id: "cliente-1" };
    await saveToken(path, credentials);
    assert.deepEqual(await loadToken(path, "cliente-1"), credentials);
    assert.equal(JSON.parse(await readFile(path, "utf8")).refresh_token, "token-ficticio");
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o077, 0);
    await saveToken(path, { ...credentials, refresh_token: "token-renovado" });
    assert.equal((await loadToken(path, "cliente-1"))?.refresh_token, "token-renovado");
    await assert.rejects(loadToken(path, "otro-cliente"), /otro cliente/);
    await writeFile(path, JSON.stringify({ type: "service_account", private_key: "ficticia" }));
    await assert.rejects(loadToken(path, "cliente-1"), /credenciales de Google/);
    await writeFile(path, "{json-corrupto");
    await assert.rejects(loadToken(path, "cliente-1"), /corrupto/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
