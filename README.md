BORRAR APIKEY Openrouter - Openclaw
SE LEAKEO POR CLI

# MVP: tablero y factura por WhatsApp

Este bot usa Baileys, Node.js y TypeScript. Recibe dos fotos por WhatsApp en cualquier orden: tablero y factura de combustible. Si llega el tablero, lee el kilometraje y el combustible con OpenRouter, muestra en consola el kilometraje antes de su confianza y pide la factura cuando la confianza es **mayor que 80 %**. Si llega la factura primero, pide la foto del tablero. De la factura extrae galones, cantidad, valor de la recarga, tipo de combustible, precio por galón, fecha y hora. Con las dos fotos agrega una fila a Google Sheets y confirma por WhatsApp. Si una foto no se puede leer, pide otra.

## Preparación

Requiere Node.js 20 o superior. Instala dependencias y configura `.env`:

```powershell
npm install
Copy-Item .env.example .env
```

Configura `OPENROUTER_API_KEY` y `OPENROUTER_MODEL`. El modelo debe aceptar imágenes y `response_format: json_schema`.

## Google Sheets

Habilita Google Sheets API en Google Cloud, crea una cuenta de servicio, descarga sus credenciales JSON y comparte la hoja con el correo de esa cuenta como **Editor**. En la fila 1 de la pestaña usa exactamente estas nueve cabeceras, en este orden:

```text
TELF | KILOMETRAJE | COMBUSTIBLE | FECHA | HORA | Precio por Galón | Galones | Tipo de Combustible | Valor de la Recarga
```

Configura en `.env`:

```dotenv
GOOGLE_SPREADSHEET_ID=ID_DE_LA_URL_DE_TU_HOJA
GOOGLE_SHEET_NAME=Lecturas
GOOGLE_APPLICATION_CREDENTIALS=./google-service-account.json
```

El archivo de credenciales y `.env` están excluidos de Git. `TELF` guarda el número si WhatsApp lo entrega; cuando llega un identificador `@lid`, guarda ese WhatsApp ID. `FECHA` y `HORA` se leen de la factura. Si no se distinguen, esas celdas quedan vacías. `Cantidad` se extrae y se muestra en consola, pero no se escribe en Sheets porque no hay una columna para ella. La foto de la factura se procesa para extraer datos; no se almacena en Drive ni en Sheets. La fila se agrega solo después de recibir las dos fotos. Si la configuración de Sheets está vacía, los datos conjuntos se imprimen como JSON en consola.

## Uso

```powershell
npm run dev
```

Escanea el QR en **WhatsApp > Dispositivos vinculados > Vincular dispositivo**. La sesión de WhatsApp se guarda en `auth_info_baileys/`. Desde otro número, en un chat privado, envía la foto del tablero o de la factura. El bot pedirá la foto que falta. Las dos fotos deben llegar en una ventana de **20 segundos contados desde la recepción de la primera**. Si falta una, responde que la sesión de captura se cerró y descarta la primera lectura. En ese caso puedes empezar otra vez con cualquiera de las dos fotos. El estado de espera se mantiene en memoria por chat; si reinicias el proceso entre ambas fotos, vuelve a enviar la primera foto.

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
