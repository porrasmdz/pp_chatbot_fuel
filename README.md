# MVP: tablero y factura por WhatsApp

Este bot usa Baileys, Node.js y TypeScript. Recibe dos fotos por WhatsApp en cualquier orden: tablero y factura de combustible. La primera foto abre una sesión de **5 minutos**. El bot espera **5 segundos** antes de analizar y responder, para reunir las dos fotos si llegan juntas. Si solo llega una foto válida, confirma la sesión y pide la otra en un único mensaje. Cada foto requiere todos sus campos legibles y porcentajes de nitidez y confianza de al menos **30 %**. La nitidez de 30 a 79 % se registra en `FOTOS_SIN_NITIDEZ` sin notificarla por WhatsApp. Solo un porcentaje menor de 30 % o un campo faltante, incluido `COMBUSTIBLE`, aparece como error `🔴`. El bot muestra únicamente los encabezados de las fotos con errores y pide repetir la toma mostrando los campos faltantes. Con ambas fotos válidas agrega una fila a Google Sheets, envía una confirmación breve con `✅` y cierra la sesión. La validación del teléfono contra `PERSONAS` está desactivada por ahora.

## Imagen Docker y GitHub Container Registry

La imagen ejecuta el bot con Node.js 22. Construye la imagen desde la raíz del repositorio:

```powershell
docker build -t ghcr.io/porrasmdz/pp_chatbot_fuel:latest .
```

Para publicarla en GitHub Container Registry, usa un personal access token (classic) de GitHub con permiso `write:packages` y ejecuta:

```powershell
$env:GHCR_TOKEN = "TU_TOKEN"
$env:GHCR_TOKEN | docker login ghcr.io -u porrasmdz --password-stdin
docker push ghcr.io/porrasmdz/pp_chatbot_fuel:latest
Remove-Item Env:GHCR_TOKEN
```

## Despliegue en VPS con Docker Compose

La VPS necesita Docker con el plugin Compose, el archivo `.env` y, si usas Google Sheets, el JSON de la cuenta de servicio. Estos archivos no vienen en el repositorio ni en la imagen. El `compose.yaml` monta `./keys` de la VPS en `/app/keys` como solo lectura y crea el volumen `chatbot_data` para la sesión de WhatsApp y `rate_limits.json`.

**Primera instalación.** En la VPS (Linux):

```bash
git clone https://github.com/porrasmdz/pp_chatbot_fuel.git ~/pp_chatbot_fuel
cd ~/pp_chatbot_fuel
mkdir -p keys
```

Desde tu PC, ubicado en la carpeta local de este proyecto, copia los archivos privados por SSH. Sustituye `usuario@IP_DE_TU_VPS` por tu usuario y dirección reales:

```powershell
scp .env usuario@IP_DE_TU_VPS:~/pp_chatbot_fuel/.env
scp keys/gcloud-keys.json usuario@IP_DE_TU_VPS:~/pp_chatbot_fuel/keys/gcloud-keys.json
```

Si todavía no tienes `.env`, créalo a partir de `.env.example` y completa `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` y las tres variables de Google Sheets. En la VPS, `GOOGLE_APPLICATION_CREDENTIALS` debe valer `./keys/gcloud-keys.json`. Si no usas Sheets, deja vacías las tres variables `GOOGLE_*` y omite la segunda copia `scp`.

Vuelve a la VPS y protege los archivos copiados:

```bash
cd ~/pp_chatbot_fuel
chmod 600 .env
if [ -f keys/gcloud-keys.json ]; then chmod 600 keys/gcloud-keys.json; fi
```

Si la imagen de GHCR es privada, inicia sesión en la VPS con un token classic que tenga `read:packages`:

```bash
read -rsp 'Token GHCR: ' GHCR_TOKEN; echo
echo "$GHCR_TOKEN" | docker login ghcr.io -u porrasmdz --password-stdin
unset GHCR_TOKEN
```

Arranca el bot desde la VPS. No hace falta construir la imagen allí; Compose la descarga de GHCR:

```bash
docker compose pull
docker compose up -d
docker compose logs -f chatbot
```

El QR para vincular WhatsApp aparece en los logs la primera vez. No hace falta publicar ningún puerto: el bot inicia conexiones salientes. Para actualizaciones posteriores, primero publica la nueva imagen en GHCR y después ejecuta en la VPS:

```bash
cd ~/pp_chatbot_fuel
git pull
docker compose pull
docker compose up -d
```

## Preparación

Requiere Node.js 20 o superior. Instala dependencias y configura `.env`:

```powershell
npm install
Copy-Item .env.example .env
```

Configura `OPENROUTER_API_KEY` y `OPENROUTER_MODEL`. El modelo debe aceptar imágenes y `response_format: json_schema`.

## Google Sheets

Habilita Google Sheets API en Google Cloud, crea una cuenta de servicio, descarga sus credenciales JSON y comparte la hoja con el correo de esa cuenta como **Editor**. En la fila 1 de la pestaña usa exactamente estas 17 cabeceras, en este orden:

```text
TELF | KILOMETRAJE | COMBUSTIBLE | FECHA | HORA | Precio por Galón | Galones | Tipo de Combustible | Valor de la Recarga | PLACA | RUC ESTACIÓN | ESTACIÓN DE SERVICIO | NÚMERO DE FACTURA | FECHA FACTURA | HORA FACTURA | SUBTOTAL | IVA
```

Crea otra pestaña llamada exactamente `FOTOS_SIN_NITIDEZ` con estas cabeceras en la fila 1, en este orden (incluida la escritura de `RECIIMIENTO`):

```text
NITIDEZ (PORCENTAJE) | FECHA (FECHA DE RECIIMIENTO) | HORA (DE RECIBIMIENTO) | TELF | TIPO
```

Cada foto con nitidez desde 30 % hasta menos de 80 % agrega una fila a esa pestaña. También se registra una factura si no se distingue su número, incluso con nitidez de 80 % o más. `FECHA` y `HORA` corresponden al momento en que el servicio recibió esa foto, en `America/Guayaquil`; `TELF` usa el mismo número o `@lid` que la matriz principal. `TIPO` vale `FACTURA` o `TABLERO` y, si falta un campo, indica el motivo, por ejemplo `FACTURA - NÚMERO DE FACTURA NO SE VE`.

Configura en `.env`:

```dotenv
GOOGLE_SPREADSHEET_ID=ID_DE_LA_URL_DE_TU_HOJA
GOOGLE_SHEET_NAME=Lecturas
GOOGLE_APPLICATION_CREDENTIALS=./google-service-account.json
```

El archivo de credenciales y `.env` están excluidos de Git. `TELF` lo define el servicio Node.js a partir del remitente: guarda el número cuando WhatsApp lo entrega y el WhatsApp ID `@lid` en caso contrario. `KILOMETRAJE` y `COMBUSTIBLE` salen de la foto del tablero. `FECHA` y `HORA` salen de la marca de tiempo del **segundo mensaje de foto válido de WhatsApp**, convertida a `America/Guayaquil`; no se extraen de la imagen. Las columnas restantes salen de la foto de la factura. `FECHA FACTURA` y `HORA FACTURA` se leen del comprobante y pueden diferir de `FECHA` y `HORA`. `Cantidad` también se extrae y valida, pero no se escribe en Sheets porque no hay una columna para ella. El prompt reconoce `Cantidad`, `CANT.`, `CTD`, `CND`, `CAN`, `CAM.` y `QTY`, y busca el valor a la izquierda del grupo `Cantidad / Valor / Total` cuando la etiqueta se ve borrosa. `NÚMERO DE FACTURA` es opcional: si no se distingue, queda vacío en la matriz principal y se anota el motivo en `FOTOS_SIN_NITIDEZ`. Los demás campos de la factura siguen siendo obligatorios. La foto se procesa para extraer datos; no se almacena en Drive ni en Sheets. La fila se agrega solo después de recibir las dos fotos válidas. Si Google Sheets no está configurado, el resultado se imprime como JSON en consola.

## Uso

```powershell
npm run dev
```

Escanea el QR en **WhatsApp > Dispositivos vinculados > Vincular dispositivo**. La sesión de WhatsApp se guarda en `auth_info_baileys/`. Desde otro número, en un chat privado, envía la foto del tablero o de la factura. Si envías ambas fotos dentro de los primeros 5 segundos, el bot omite los mensajes intermedios y responde una sola vez después de validarlas. Los 5 minutos de sesión se cuentan desde la recepción de la primera foto. Si no llegan ambas fotos válidas, responde que la sesión se cerró. Los mensajes de texto, stickers y otros contenidos reciben `CONTENIDO INVÁLIDO` solo durante una sesión activa; fuera de ella se ignoran. Más de 50 mensajes de un mismo chat en cualquier ventana de 1 minuto provocan un bloqueo de 8 horas. El estado del límite se guarda en `rate_limits.json` y el estado de la sesión de captura queda en memoria; al reiniciar el proceso se pierde una sesión de captura en curso.

Para probar una foto del tablero directamente con OpenRouter, sin WhatsApp:

```powershell
npm run dev -- "C:\ruta\tablero.jpg"
```

Para verificar el código:

```powershell
npm run build
npm test
```

Baileys usa WhatsApp Web como dispositivo vinculado. Una escritura a Google Sheets puede duplicarse si se reintenta tras un fallo de red.
