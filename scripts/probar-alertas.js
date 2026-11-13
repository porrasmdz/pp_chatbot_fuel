import { existsSync } from "node:fs";
import { currentMonthPeriod } from "../dist/alertas-rules.js";
import { AlertasService } from "../dist/alertas-service.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const month = currentMonthPeriod();
const options = { fechaInicio: month.inicio, fechaFin: month.fin };
for (const argument of process.argv.slice(2)) {
  if (argument.startsWith("--inicio=")) options.fechaInicio = argument.slice("--inicio=".length);
  else if (argument.startsWith("--fin=")) options.fechaFin = argument.slice("--fin=".length);
  else {
    console.error(`Argumento no reconocido: ${argument}`);
    process.exit(2);
  }
}

try {
  const resultado = await AlertasService.fromEnv().obtenerAlertas(options);
  console.log(JSON.stringify(resultado, null, 2));
} catch (error) {
  console.error("No se pudieron consolidar las alertas:", error);
  process.exitCode = 1;
}
