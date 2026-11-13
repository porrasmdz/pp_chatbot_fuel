export type SheetValue = string | number | boolean | null;
export type SheetRows = SheetValue[][];

export type AlertasData = {
  parametros: SheetRows;
  matriz: SheetRows;
  personas: SheetRows;
  calendario: SheetRows;
  indicadores: SheetRows;
  promedios: SheetRows;
};

export type AlertType =
  | "REPOSTAJE_VIERNES" | "FUERA_DE_JORNADA" | "MULTIPLES_REPOSTAJES" | "PICO_RECARGA"
  | "KILOMETRAJE_EN_LIMITE" | "KILOMETRAJE_EXCEDIDO" | "PRESUPUESTO_EXCEDIDO";

export type Alerta = {
  id: string;
  tipo: AlertType;
  alcance: "EVENTO" | "PERIODO" | "REPOSTAJE" | "DIA" | "VEHICULO" | "GLOBAL";
  fecha: string | null;
  hora?: string | null;
  placa: string | null;
  empleado: string | null;
  descripcion: string;
  origen: "Calendario" | "Indicadores" | "PROMEDIOS_REPOSTAJE" | "Matriz";
  repostajes?: RepostajeRef[];
  detalles: Record<string, unknown>;
};

export type RepostajeRef = {
  idRegistro: string;
  filaMatriz: number;
  placa: string;
  fecha: string;
  hora: string | null;
  kilometraje: number | null;
  valorRecarga: number | null;
  estacion: string | null;
  numeroFactura: string | null;
};

export type ErrorConciliacion = {
  tipo: AlertType;
  origen: Alerta["origen"];
  placa: string | null;
  fecha: string | null;
  hora: string | null;
  motivo: string;
};

export type ResultadoAlertas = {
  fechaGeneracion: string;
  periodo: { inicio: string; fin: string };
  resumen: {
    totalAlertas: number;
    totalVehiculosConAlertas: number;
    totalDiasConAlertas: number;
    sinHistorialSuficiente: number;
    porTipo: Record<AlertType, number>;
    porPlaca: Record<string, { totalAlertas: number; porTipo: Partial<Record<AlertType, number>> }>;
  };
  alertas: Alerta[];
  erroresLectura: Array<{ hoja: string; fila: number; motivo: string }>;
  erroresConciliacion: ErrorConciliacion[];
};

type Parametros = {
  inicio: string;
  fin: string;
  combustible: string;
  estacion: string;
  presupuesto: number;
  kmMinimo: number;
  kmMaximo: number;
  horaInicio: string;
  horaFin: string;
  umbralPico: number;
};

type Registro = {
  fila: number;
  fecha: string;
  hora: string | null;
  placa: string;
  kilometraje: number | null;
  valor: number | null;
  combustible: string;
  estacion: string;
  numeroFactura: string | null;
};

type ErrorLectura = ResultadoAlertas["erroresLectura"][number];

function normalize(value: SheetValue | undefined): string {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().replace(/\s+/g, " ").toUpperCase();
}

function text(value: SheetValue | undefined): string {
  return String(value ?? "").trim();
}

export function normalizeDate(value: SheetValue | undefined): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86_400_000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }
  const raw = text(value);
  if (!raw) return null;
  let year: number, month: number, day: number;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) [year, month, day] = raw.split("-").map(Number);
  else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(raw)) [day, month, year] = raw.split("/").map(Number);
  else if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    const instant = new Date(raw);
    if (Number.isNaN(instant.getTime())) return null;
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Guayaquil", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant).map(part => [part.type, part.value]));
    year = Number(parts.year); month = Number(parts.month); day = Number(parts.day);
  } else return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  return `${year.toString().padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function normalizeTime(value: SheetValue | undefined): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const minutes = Math.round((value - Math.floor(value)) * 1440) % 1440;
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  }
  const raw = text(value);
  if (!raw) return null;
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i.exec(raw);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59 || hour > (match[3] ? 12 : 23) || (match[3] && hour === 0)) return null;
  if (match[3]) hour = hour % 12 + (normalize(match[3]) === "PM" ? 12 : 0);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function number(value: SheetValue | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = text(value).replace(/[$\s]/g, "");
  if (!raw) return null;
  const cleaned = raw.includes(",") && raw.includes(".")
    ? raw.lastIndexOf(",") > raw.lastIndexOf(".") ? raw.replace(/\./g, "").replace(",", ".") : raw.replace(/,/g, "")
    : raw.replace(",", ".");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function header(rows: SheetRows, sheet: string, required: string[]): { start: number; columns: Map<string, number> } {
  for (let index = 0; index < rows.length; index++) {
    const columns = new Map<string, number>();
    rows[index].forEach((value, column) => { const key = normalize(value); if (key && !columns.has(key)) columns.set(key, column); });
    if (required.every(name => columns.has(normalize(name)))) return { start: index + 1, columns };
  }
  throw new Error(`No se encontraron los encabezados requeridos de ${sheet}: ${required.join(", ")}`);
}

function cell(row: SheetValue[], columns: Map<string, number>, name: string): SheetValue | undefined {
  return row[columns.get(normalize(name)) ?? -1];
}

function valueByLabel(rows: SheetRows, label: string): SheetValue | undefined {
  return rows.find(row => normalize(row[0]) === normalize(label))?.[1];
}

function requiredNumber(rows: SheetRows, label: string): number {
  const parsed = number(valueByLabel(rows, label));
  if (parsed === null) throw new Error(`Parámetro inválido o ausente: ${label}`);
  return parsed;
}

function parameters(rows: SheetRows): Parametros {
  const inicio = normalizeDate(valueByLabel(rows, "INICIO PERIODO"));
  const fin = normalizeDate(valueByLabel(rows, "FIN PERIODO"));
  const horaInicio = normalizeTime(valueByLabel(rows, "HORA INICIO JORNADA"));
  const horaFin = normalizeTime(valueByLabel(rows, "HORA FIN JORNADA"));
  if (!inicio || !fin || !horaInicio || !horaFin) throw new Error("Fechas u horario inválidos en PARAMETROS");
  const umbralPico = requiredNumber(rows, "UMBRAL_PICO_RECARGA");
  if (umbralPico < 0 || umbralPico > 10) throw new Error("UMBRAL_PICO_RECARGA fuera de rango");
  const kmMinimo = requiredNumber(rows, "LÍMITE KM MÍNIMO");
  const kmMaximo = requiredNumber(rows, "LÍMITE KM MÁXIMO");
  if (kmMinimo < 0 || kmMaximo < kmMinimo) throw new Error("Límites de kilometraje inválidos en PARAMETROS");
  return {
    inicio, fin, horaInicio, horaFin, umbralPico,
    combustible: text(valueByLabel(rows, "TIPO DE COMBUSTIBLE")) || "TODOS",
    estacion: text(valueByLabel(rows, "ESTACIÓN DE SERVICIO")) || "TODOS",
    presupuesto: requiredNumber(rows, "PRESUPUESTO MENSUAL"),
    kmMinimo, kmMaximo,
  };
}

function matrixRecords(rows: SheetRows, errors: ErrorLectura[]): Registro[] {
  const { start, columns } = header(rows, "Matriz", ["TELF", "KILOMETRAJE", "FECHA", "HORA", "Valor de la Recarga", "PLACA", "Tipo de Combustible", "ESTACIÓN DE SERVICIO", "NÚMERO DE FACTURA"]);
  const records: Registro[] = [];
  for (let index = start; index < rows.length; index++) {
    const row = rows[index];
    if (!row.some(value => text(value))) continue;
    const dateRaw = cell(row, columns, "FECHA");
    const plateRaw = cell(row, columns, "PLACA");
    const fecha = normalizeDate(dateRaw);
    const placa = normalize(plateRaw);
    if (!fecha || !placa) {
      errors.push({ hoja: "Matriz", fila: index + 1, motivo: !fecha ? "FECHA inválida" : "PLACA vacía" });
      continue;
    }
    const timeRaw = cell(row, columns, "HORA");
    const hora = normalizeTime(timeRaw);
    if (!hora) errors.push({ hoja: "Matriz", fila: index + 1, motivo: text(timeRaw) ? "HORA inválida" : "HORA vacía" });
    const amountRaw = cell(row, columns, "Valor de la Recarga");
    const valor = number(amountRaw);
    if (text(amountRaw) && valor === null) errors.push({ hoja: "Matriz", fila: index + 1, motivo: "Valor de la Recarga inválido" });
    const kmRaw = cell(row, columns, "KILOMETRAJE");
    const kilometraje = number(kmRaw);
    if (text(kmRaw) && kilometraje === null) errors.push({ hoja: "Matriz", fila: index + 1, motivo: "KILOMETRAJE inválido" });
    records.push({ fila: index + 1, fecha, hora, placa, valor, kilometraje, combustible: text(cell(row, columns, "Tipo de Combustible")), estacion: text(cell(row, columns, "ESTACIÓN DE SERVICIO")), numeroFactura: text(cell(row, columns, "NÚMERO DE FACTURA")) || null });
  }
  return records;
}

function peopleByPlate(rows: SheetRows): Map<string, string> {
  const { start, columns } = header(rows, "Personas", ["NOMBRE", "PLACA"]);
  const people = new Map<string, string>();
  for (const row of rows.slice(start)) {
    const placa = normalize(cell(row, columns, "PLACA"));
    const nombre = text(cell(row, columns, "NOMBRE"));
    if (placa && nombre && !people.has(placa)) people.set(placa, nombre);
  }
  return people;
}

function ecuadorNow(now: Date): { fecha: string; timestamp: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Guayaquil", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map(part => [part.type, part.value]));
  const fecha = `${parts.year}-${parts.month}-${parts.day}`;
  return { fecha, timestamp: `${fecha}T${parts.hour}:${parts.minute}:${parts.second}-05:00` };
}

export function currentMonthPeriod(now = new Date()): { inicio: string; fin: string } {
  const current = ecuadorNow(now).fecha;
  const [year, month] = current.split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { inicio: `${current.slice(0, 7)}-01`, fin: `${current.slice(0, 7)}-${String(last).padStart(2, "0")}` };
}

function inPeriod(fecha: string, inicio: string, fin: string, corte: string): boolean {
  return fecha >= inicio && fecha <= fin && fecha <= corte;
}

function plates(value: SheetValue | undefined): string[] {
  return [...new Set(text(value).split(",").map(plate => normalize(plate)).filter(Boolean))];
}

const DESCRIPTIONS: Record<AlertType, string> = {
  REPOSTAJE_VIERNES: "Repostaje registrado en viernes",
  FUERA_DE_JORNADA: "Repostaje registrado fuera del horario permitido",
  MULTIPLES_REPOSTAJES: "Más de un repostaje de la misma placa en el día",
  PICO_RECARGA: "Recarga superior al límite basado en las cinco anteriores",
  KILOMETRAJE_EN_LIMITE: "Kilometraje recorrido dentro del rango de alerta",
  KILOMETRAJE_EXCEDIDO: "Kilometraje recorrido superior al máximo permitido",
  PRESUPUESTO_EXCEDIDO: "Gasto del período superior al presupuesto configurado",
};

function event(type: AlertType, fecha: string, placa: string, empleado: string | null, origen: Alerta["origen"], detalles: Record<string, unknown>, suffix = ""): Alerta {
  return { id: `${fecha}_${placa}_${type}${suffix}`, tipo: type, alcance: "EVENTO", fecha, placa, empleado, descripcion: DESCRIPTIONS[type], origen, detalles };
}

function periodAlert(type: AlertType, inicio: string, fin: string, placa: string | null, empleado: string | null, origen: Alerta["origen"], detalles: Record<string, unknown>): Alerta {
  return { id: `${inicio}_${fin}_${placa ?? "GENERAL"}_${type}`, tipo: type, alcance: "PERIODO", fecha: null, placa, empleado, descripcion: DESCRIPTIONS[type], origen, detalles };
}

function sheetPeaks(rows: SheetRows, inicio: string, fin: string, corte: string, people: Map<string, string>, errors: ErrorLectura[]): { alerts: Alerta[]; insufficient: number } {
  const { start, columns } = header(rows, "PROMEDIOS_REPOSTAJE", ["FECHA", "HORA", "PLACA", "VALOR RECARGA", "RECARGAS ANTERIORES", "PROMEDIO ÚLTIMAS 5", "LÍMITE PERMITIDO", "ESTADO"]);
  const alerts: Alerta[] = [];
  let insufficient = 0;
  for (let index = start; index < rows.length; index++) {
    const row = rows[index];
    const estado = normalize(cell(row, columns, "ESTADO"));
    if (!estado || estado === "OK") continue;
    const fecha = normalizeDate(cell(row, columns, "FECHA"));
    if (!fecha) {
      errors.push({ hoja: "PROMEDIOS_REPOSTAJE", fila: index + 1, motivo: "FECHA inválida" });
      continue;
    }
    if (!inPeriod(fecha, inicio, fin, corte)) continue;
    if (estado === "SIN HISTORIAL SUFICIENTE") { insufficient++; continue; }
    if (estado !== "SALVEDAD") {
      errors.push({ hoja: "PROMEDIOS_REPOSTAJE", fila: index + 1, motivo: `ESTADO desconocido: ${estado}` });
      continue;
    }
    const placa = normalize(cell(row, columns, "PLACA"));
    if (!placa) { errors.push({ hoja: "PROMEDIOS_REPOSTAJE", fila: index + 1, motivo: "SALVEDAD sin PLACA" }); continue; }
    const hora = normalizeTime(cell(row, columns, "HORA"));
    if (!hora) errors.push({ hoja: "PROMEDIOS_REPOSTAJE", fila: index + 1, motivo: "HORA inválida en pico" });
    alerts.push(event("PICO_RECARGA", fecha, placa, people.get(placa) ?? null, "PROMEDIOS_REPOSTAJE", {
      hora,
      valorRecarga: number(cell(row, columns, "VALOR RECARGA")),
      recargasAnteriores: number(cell(row, columns, "RECARGAS ANTERIORES")),
      promedioUltimas5: number(cell(row, columns, "PROMEDIO ÚLTIMAS 5")),
      limitePermitido: number(cell(row, columns, "LÍMITE PERMITIDO")),
    }, `_FILA_${index + 1}`));
  }
  return { alerts, insufficient };
}

function calendarAlerts(rows: SheetRows, records: Registro[], inicio: string, fin: string, corte: string, params: Parametros, people: Map<string, string>, peaks: Alerta[], errors: ErrorLectura[]): Alerta[] {
  const { start, columns } = header(rows, "Calendario", ["FECHA", "REPOSTADORES", "REPOSTADORES_FUERA_DE_JORNADA", "REPOSTADORES_MAS_DE_UN_REPOSTAJE", "REPOSTADORES_PICO_RECARGA", "VALIDADOR VIERNES", "VALIDADOR JORNADA", "VALIDADOR MAS DE UN REPOSTAJE", "VALIDADOR_PICO_RECARGA"]);
  const definitions: Array<{ validator: string; source: string; type: AlertType }> = [
    { validator: "VALIDADOR VIERNES", source: "REPOSTADORES", type: "REPOSTAJE_VIERNES" },
    { validator: "VALIDADOR JORNADA", source: "REPOSTADORES_FUERA_DE_JORNADA", type: "FUERA_DE_JORNADA" },
    { validator: "VALIDADOR MAS DE UN REPOSTAJE", source: "REPOSTADORES_MAS_DE_UN_REPOSTAJE", type: "MULTIPLES_REPOSTAJES" },
    { validator: "VALIDADOR_PICO_RECARGA", source: "REPOSTADORES_PICO_RECARGA", type: "PICO_RECARGA" },
  ];
  const peakDays = new Set(peaks.map(alert => `${alert.fecha}|${alert.placa}`));
  const alerts: Alerta[] = [];
  for (let index = start; index < rows.length; index++) {
    const row = rows[index];
    if (!row.some(value => text(value))) continue;
    const fecha = normalizeDate(cell(row, columns, "FECHA"));
    const hasWarning = definitions.some(definition => normalize(cell(row, columns, definition.validator)) === "SALVEDAD");
    if (!fecha) {
      if (hasWarning) errors.push({ hoja: "Calendario", fila: index + 1, motivo: "SALVEDAD sin FECHA válida" });
      continue;
    }
    if (!inPeriod(fecha, inicio, fin, corte)) continue;
    for (const definition of definitions) {
      const status = normalize(cell(row, columns, definition.validator));
      if (status !== "SALVEDAD") {
        if (status && status !== "OK") errors.push({ hoja: "Calendario", fila: index + 1, motivo: `${definition.validator} desconocido: ${status}` });
        continue;
      }
      const affected = plates(cell(row, columns, definition.source));
      if (!affected.length) {
        errors.push({ hoja: "Calendario", fila: index + 1, motivo: `${definition.validator} sin placas` });
        continue;
      }
      for (const placa of affected) {
        if (definition.type === "PICO_RECARGA" && peakDays.has(`${fecha}|${placa}`)) continue;
        const dayRecords = records.filter(record => record.fecha === fecha && record.placa === placa);
        const details: Record<string, unknown> = {};
        if (definition.type === "FUERA_DE_JORNADA") {
          details.horas = [...new Set(dayRecords.filter(record => record.hora && (record.hora < params.horaInicio || record.hora > params.horaFin)).map(record => record.hora))];
          details.horaInicioPermitida = params.horaInicio;
          details.horaFinPermitida = params.horaFin;
        }
        if (definition.type === "MULTIPLES_REPOSTAJES") details.cantidadRepostajes = dayRecords.length;
        alerts.push(event(definition.type, fecha, placa, people.get(placa) ?? null, "Calendario", details));
      }
    }
  }
  return alerts;
}

function indicatorAlerts(rows: SheetRows, inicio: string, fin: string, people: Map<string, string>, errors: ErrorLectura[]): Alerta[] {
  const { start, columns } = header(rows, "Indicadores", ["EMPLEADO", "PLACA", "KM INICIAL", "KM FINAL", "KM RECORRIDOS", "VALIDADOR KMAJE"]);
  const alerts: Alerta[] = [];
  for (let index = start; index < rows.length; index++) {
    const row = rows[index];
    const validator = normalize(cell(row, columns, "VALIDADOR KMAJE"));
    if (!validator || validator === "OK") continue;
    const type: AlertType | null = validator === "EN EL LIMITE" ? "KILOMETRAJE_EN_LIMITE" : validator === "EXCEDIO" ? "KILOMETRAJE_EXCEDIDO" : null;
    if (!type) { errors.push({ hoja: "Indicadores", fila: index + 1, motivo: `VALIDADOR KMAJE desconocido: ${validator}` }); continue; }
    const placa = normalize(cell(row, columns, "PLACA"));
    if (!placa) { errors.push({ hoja: "Indicadores", fila: index + 1, motivo: "Alerta de kilometraje sin PLACA" }); continue; }
    const employee = text(cell(row, columns, "EMPLEADO"));
    alerts.push(periodAlert(type, inicio, fin, placa, employee || people.get(placa) || null, "Indicadores", {
      kilometrajeInicial: number(cell(row, columns, "KM INICIAL")),
      kilometrajeFinal: number(cell(row, columns, "KM FINAL")),
      kmRecorridos: number(cell(row, columns, "KM RECORRIDOS")),
    }));
  }
  return alerts;
}

function matchingRecords(records: Registro[], params: Parametros, inicio: string, fin: string, corte: string): Registro[] {
  return records.filter(record => inPeriod(record.fecha, inicio, fin, corte)
    && (normalize(params.combustible) === "TODOS" || normalize(record.combustible) === normalize(params.combustible))
    && (normalize(params.estacion) === "TODOS" || normalize(record.estacion) === normalize(params.estacion)));
}

function recalculatedDaily(records: Registro[], inicio: string, fin: string, corte: string, params: Parametros, people: Map<string, string>): Alerta[] {
  const grouped = new Map<string, Registro[]>();
  for (const record of records) {
    if (!inPeriod(record.fecha, inicio, fin, corte)) continue;
    const key = `${record.fecha}|${record.placa}`;
    const list = grouped.get(key) ?? [];
    list.push(record);
    grouped.set(key, list);
  }
  const alerts: Alerta[] = [];
  for (const list of grouped.values()) {
    const { fecha, placa } = list[0];
    const employee = people.get(placa) ?? null;
    if (new Date(`${fecha}T00:00:00Z`).getUTCDay() === 5) alerts.push(event("REPOSTAJE_VIERNES", fecha, placa, employee, "Matriz", {}));
    const outOfHours = list.filter(record => record.hora && (record.hora < params.horaInicio || record.hora > params.horaFin));
    if (outOfHours.length) alerts.push(event("FUERA_DE_JORNADA", fecha, placa, employee, "Matriz", {
      horas: [...new Set(outOfHours.map(record => record.hora))],
      horaInicioPermitida: params.horaInicio, horaFinPermitida: params.horaFin,
    }));
    if (list.length > 1) alerts.push(event("MULTIPLES_REPOSTAJES", fecha, placa, employee, "Matriz", { cantidadRepostajes: list.length }));
  }
  return alerts;
}

function recalculatedPeaks(records: Registro[], inicio: string, fin: string, corte: string, umbral: number, people: Map<string, string>): { alerts: Alerta[]; insufficient: number } {
  const chronological = records.filter(record => record.hora !== null && record.valor !== null)
    .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.hora!.localeCompare(b.hora!) || a.fila - b.fila);
  const histories = new Map<string, number[]>();
  const alerts: Alerta[] = [];
  let insufficient = 0;
  for (const record of chronological) {
    const history = histories.get(record.placa) ?? [];
    if (inPeriod(record.fecha, inicio, fin, corte)) {
      if (history.length < 5) insufficient++;
      else {
        const average = history.reduce((sum, value) => sum + value, 0) / 5;
        const limit = average * (1 + umbral);
        if (record.valor! > limit) alerts.push(event("PICO_RECARGA", record.fecha, record.placa, people.get(record.placa) ?? null, "Matriz", {
          hora: record.hora, valorRecarga: record.valor, recargasAnteriores: history.length,
          promedioUltimas5: average, limitePermitido: limit,
        }, `_FILA_${record.fila}`));
      }
    }
    history.push(record.valor!);
    if (history.length > 5) history.shift();
    histories.set(record.placa, history);
  }
  return { alerts, insufficient };
}

function recalculatedMileage(records: Registro[], inicio: string, fin: string, params: Parametros, people: Map<string, string>): Alerta[] {
  const grouped = new Map<string, number[]>();
  for (const record of records) {
    if (record.kilometraje === null) continue;
    const list = grouped.get(record.placa) ?? [];
    list.push(record.kilometraje);
    grouped.set(record.placa, list);
  }
  const alerts: Alerta[] = [];
  for (const [placa, values] of grouped) {
    const initial = Math.min(...values);
    const final = Math.max(...values);
    const traveled = final - initial;
    const type: AlertType | null = traveled < params.kmMinimo ? null : traveled <= params.kmMaximo ? "KILOMETRAJE_EN_LIMITE" : "KILOMETRAJE_EXCEDIDO";
    if (type) alerts.push(periodAlert(type, inicio, fin, placa, people.get(placa) ?? null, "Matriz", {
      kilometrajeInicial: initial, kilometrajeFinal: final, kmRecorridos: traveled,
      limiteMinimo: params.kmMinimo, limiteMaximo: params.kmMaximo,
    }));
  }
  return alerts;
}

function budgetAlert(rows: SheetRows, records: Registro[], inicio: string, fin: string, corte: string, params: Parametros, recalculate: boolean, errors: ErrorLectura[]): Alerta | null {
  const gasto = recalculate
    ? matchingRecords(records, params, inicio, fin, corte).reduce((sum, record) => sum + (record.valor ?? 0), 0)
    : number(valueByLabel(rows, "GASTO TOTAL"));
  if (recalculate) {
    if (gasto === null || gasto <= params.presupuesto) return null;
  } else {
    const validator = normalize(valueByLabel(rows, "VALIDADOR PRESUPUESTO"));
    if (!validator) { errors.push({ hoja: "Indicadores", fila: 22, motivo: "VALIDADOR PRESUPUESTO vacío" }); return null; }
    if (validator === "OK") return null;
    if (gasto === null) errors.push({ hoja: "Indicadores", fila: 13, motivo: "GASTO TOTAL inválido" });
  }
  return periodAlert("PRESUPUESTO_EXCEDIDO", inicio, fin, null, null, recalculate ? "Matriz" : "Indicadores", {
    gastoTotal: gasto, presupuesto: params.presupuesto, saldoDisponible: gasto === null ? null : params.presupuesto - gasto,
    estadoValidador: recalculate ? "DESCUADRE" : text(valueByLabel(rows, "VALIDADOR PRESUPUESTO")),
  });
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function sortRecords(records: Registro[]): Registro[] {
  return [...records].sort((a, b) => a.fecha.localeCompare(b.fecha) || (a.hora ?? "").localeCompare(b.hora ?? "") || a.fila - b.fila);
}

function reconciliationError(alert: Alerta, motivo: string): ErrorConciliacion {
  return { tipo: alert.tipo, origen: alert.origen, placa: alert.placa, fecha: alert.fecha, hora: alert.hora ?? null, motivo };
}

function traceAlerts(base: Alerta[], records: Registro[], params: Parametros, people: Map<string, string>, inicio: string, fin: string, errors: ErrorConciliacion[]): Alerta[] {
  const eligible = matchingRecords(records, params, inicio, fin, fin);
  const compositeCounts = new Map<string, number>();
  const compositeKey = (record: Registro): string => `${record.placa}_${record.fecha}_${record.hora ?? "SIN_HORA"}_${record.numeroFactura ?? `SIN_FACTURA_${record.kilometraje ?? "SIN_KM"}_${record.valor ?? "SIN_VALOR"}`}`;
  for (const record of records) compositeCounts.set(compositeKey(record), (compositeCounts.get(compositeKey(record)) ?? 0) + 1);
  const reference = (record: Registro, alert: Alerta): RepostajeRef => {
    const key = compositeKey(record);
    if ((compositeCounts.get(key) ?? 0) > 1) errors.push(reconciliationError(alert, `Clave compuesta duplicada en Matriz; se distingue por fila ${record.fila}`));
    return {
      idRegistro: (compositeCounts.get(key) ?? 0) > 1 ? `${key}_FILA_${record.fila}` : key,
      filaMatriz: record.fila, placa: record.placa, fecha: record.fecha, hora: record.hora,
      kilometraje: record.kilometraje, valorRecarga: record.valor,
      estacion: record.estacion || null, numeroFactura: record.numeroFactura,
    };
  };
  const employee = (alert: Alerta, placa: string): string | null => {
    const name = people.get(placa) ?? null;
    if (!name) errors.push(reconciliationError(alert, `PLACA ${placa} sin empleado en Personas`));
    return name;
  };
  const traced: Alerta[] = [];
  for (const alert of base) {
    if (alert.tipo === "PRESUPUESTO_EXCEDIDO") {
      const included = sortRecords(eligible);
      const amounts = new Map<string, { gasto: number; cantidadRepostajes: number }>();
      for (const record of included) {
        const current = amounts.get(record.placa) ?? { gasto: 0, cantidadRepostajes: 0 };
        current.gasto += record.valor ?? 0;
        current.cantidadRepostajes++;
        amounts.set(record.placa, current);
      }
      const sum = roundMoney(included.reduce((total, record) => total + (record.valor ?? 0), 0));
      const sheetTotal = typeof alert.detalles.gastoTotal === "number" ? alert.detalles.gastoTotal : null;
      if (sheetTotal !== null && Math.abs(sum - sheetTotal) > 0.01) errors.push(reconciliationError(alert, `Gasto de Matriz (${sum}) difiere de Indicadores (${roundMoney(sheetTotal)})`));
      const budget = params.presupuesto;
      traced.push({ ...alert, alcance: "GLOBAL", fecha: null, hora: null, placa: null, empleado: null,
        repostajes: included.map(record => reference(record, alert)),
        detalles: { ...alert.detalles, periodoEvaluado: { inicio, fin }, presupuestoConfigurado: budget,
          gastoTotal: roundMoney(sheetTotal ?? sum), saldoDisponible: roundMoney(budget - (sheetTotal ?? sum)),
          excesoDolares: roundMoney((sheetTotal ?? sum) - budget),
          desglosePorPlaca: Object.fromEntries([...amounts].map(([placa, item]) => [placa, { gasto: roundMoney(item.gasto), cantidadRepostajes: item.cantidadRepostajes }])),
        },
      });
      continue;
    }
    if (!alert.placa) { errors.push(reconciliationError(alert, "Alerta sin PLACA")); continue; }
    const name = employee(alert, alert.placa);
    if (alert.tipo === "KILOMETRAJE_EN_LIMITE" || alert.tipo === "KILOMETRAJE_EXCEDIDO") {
      const included = sortRecords(eligible.filter(record => record.placa === alert.placa));
      if (!included.length) { errors.push(reconciliationError(alert, "No se encontraron los repostajes utilizados por Indicadores")); continue; }
      const mileage = included.map(record => record.kilometraje).filter((value): value is number => value !== null);
      const initial = mileage.length ? Math.min(...mileage) : null;
      const final = mileage.length ? Math.max(...mileage) : null;
      const traveled = initial !== null && final !== null ? final - initial : null;
      if (traveled === null) errors.push(reconciliationError(alert, "No hay kilometrajes numéricos en los registros del período"));
      const indicated = alert.detalles.kmRecorridos;
      if (traveled !== null && typeof indicated === "number" && Math.abs(traveled - indicated) > 0.01) errors.push(reconciliationError(alert, `Km de Matriz (${traveled}) difieren de Indicadores (${indicated})`));
      const first = included[0], last = included[included.length - 1];
      const refs = included.map(record => reference(record, alert));
      traced.push({ ...alert, alcance: "VEHICULO", fecha: null, hora: null, empleado: name, repostajes: refs,
        detalles: { ...alert.detalles, kilometrajeInicial: initial, kilometrajeFinal: final, kmRecorridos: traveled,
          limiteMinimo: params.kmMinimo, limiteMaximo: params.kmMaximo,
          primerRepostaje: { fecha: first.fecha, hora: first.hora }, ultimoRepostaje: { fecha: last.fecha, hora: last.hora },
          referenciasRegistros: refs.map(ref => ref.idRegistro),
        },
      });
      continue;
    }
    if (!alert.fecha) { errors.push(reconciliationError(alert, "Alerta diaria sin FECHA")); continue; }
    const day = sortRecords(records.filter(record => record.placa === alert.placa && record.fecha === alert.fecha));
    if (!day.length) { errors.push(reconciliationError(alert, "No se encontró el evento original en Matriz")); continue; }
    if (alert.tipo === "REPOSTAJE_VIERNES") {
      traced.push({ ...alert, alcance: "DIA", hora: null, empleado: name, repostajes: day.map(record => reference(record, alert)) });
      continue;
    }
    if (alert.tipo === "MULTIPLES_REPOSTAJES") {
      if (day.length < 2) { errors.push(reconciliationError(alert, "Calendario indica múltiples repostajes, pero Matriz tiene menos de dos")); continue; }
      traced.push({ ...alert, alcance: "DIA", hora: null, empleado: name, repostajes: day.map(record => reference(record, alert)),
        detalles: { ...alert.detalles, cantidadRepostajes: day.length },
      });
      continue;
    }
    if (alert.tipo === "FUERA_DE_JORNADA") {
      const offending = day.filter(record => record.hora !== null && (record.hora < params.horaInicio || record.hora > params.horaFin));
      if (!offending.length) { errors.push(reconciliationError(alert, "Calendario indica fuera de jornada, pero no hay horas fuera del rango en Matriz")); continue; }
      for (const record of offending) {
        const ref = reference(record, alert);
        traced.push({ ...alert, id: `${ref.idRegistro}_FUERA_DE_JORNADA`, alcance: "REPOSTAJE", hora: record.hora, empleado: name, repostajes: [ref],
          detalles: { horaInicioPermitida: params.horaInicio, horaFinPermitida: params.horaFin },
        });
      }
      continue;
    }
    if (alert.tipo === "PICO_RECARGA") {
      let candidates: Registro[] = [];
      if (alert.origen === "Calendario") {
        const recomputed = recalculatedPeaks(records, alert.fecha, alert.fecha, alert.fecha, params.umbralPico, people).alerts;
        candidates = recomputed.filter(peak => peak.placa === alert.placa).map(peak => records.find(record => peak.id.endsWith(`_FILA_${record.fila}`))).filter((record): record is Registro => Boolean(record));
      } else {
        const hora = typeof alert.detalles.hora === "string" ? alert.detalles.hora : null;
        const valor = typeof alert.detalles.valorRecarga === "number" ? alert.detalles.valorRecarga : null;
        candidates = day.filter(record => record.hora === hora && (valor === null || (record.valor !== null && Math.abs(record.valor - valor) < 0.01)));
      }
      if (!candidates.length) { errors.push(reconciliationError(alert, "No se encontró el pico original por placa, fecha y hora en Matriz")); continue; }
      if (candidates.length > 1) { errors.push(reconciliationError(alert, "Pico ambiguo: varios repostajes comparten placa, fecha y hora")); continue; }
      const record = candidates[0];
      const ref = reference(record, alert);
      const average = typeof alert.detalles.promedioUltimas5 === "number" ? alert.detalles.promedioUltimas5 : null;
      const limit = typeof alert.detalles.limitePermitido === "number" ? alert.detalles.limitePermitido : null;
      const computed = alert.origen === "Calendario" ? recalculatedPeaks(records, alert.fecha, alert.fecha, alert.fecha, params.umbralPico, people).alerts.find(peak => peak.id.endsWith(`_FILA_${record.fila}`)) : null;
      const finalAverage = average ?? (typeof computed?.detalles.promedioUltimas5 === "number" ? computed.detalles.promedioUltimas5 : null);
      const finalLimit = limit ?? (typeof computed?.detalles.limitePermitido === "number" ? computed.detalles.limitePermitido : null);
      traced.push({ ...alert, id: `${ref.idRegistro}_PICO_RECARGA`, alcance: "REPOSTAJE", hora: record.hora, empleado: name, repostajes: [ref],
        detalles: { ...alert.detalles, hora: record.hora, valorRecarga: record.valor, promedioUltimas5: finalAverage,
          limitePermitido: finalLimit, porcentajeExceso: record.valor !== null && finalLimit !== null && finalLimit > 0 ? (record.valor / finalLimit - 1) * 100 : null,
          numeroFactura: record.numeroFactura,
        },
      });
    }
  }
  return traced;
}

export function consolidarAlertas(data: AlertasData, options: { fechaInicio?: string; fechaFin?: string } = {}, now = new Date()): ResultadoAlertas {
  const params = parameters(data.parametros);
  const inicio = options.fechaInicio === undefined ? params.inicio : normalizeDate(options.fechaInicio);
  const fin = options.fechaFin === undefined ? params.fin : normalizeDate(options.fechaFin);
  if (!inicio || !fin || inicio > fin) throw new Error("Período inválido: usa fechas YYYY-MM-DD con inicio <= fin");
  const customPeriod = inicio !== params.inicio || fin !== params.fin;
  const localNow = ecuadorNow(now);
  const corte = fin;
  const errors: ErrorLectura[] = [];
  const records = matrixRecords(data.matriz, errors);
  const people = peopleByPlate(data.personas);
  const recalculate = customPeriod;
  let alerts: Alerta[] = [];
  let insufficient = 0;
  if (recalculate) {
    alerts.push(...recalculatedDaily(records, inicio, fin, corte, params, people));
    const peaks = recalculatedPeaks(records, inicio, fin, corte, params.umbralPico, people);
    alerts.push(...peaks.alerts);
    insufficient = peaks.insufficient;
    alerts.push(...recalculatedMileage(matchingRecords(records, params, inicio, fin, corte), inicio, fin, params, people));
  } else {
    const peaks = sheetPeaks(data.promedios, inicio, fin, corte, people, errors);
    alerts.push(...peaks.alerts);
    insufficient = peaks.insufficient;
    alerts.push(...calendarAlerts(data.calendario, records, inicio, fin, corte, params, people, peaks.alerts, errors));
    alerts.push(...indicatorAlerts(data.indicadores, inicio, fin, people, errors));
  }
  const budget = budgetAlert(data.indicadores, records, inicio, fin, corte, params, recalculate, errors);
  if (budget) alerts.push(budget);
  const erroresConciliacion: ErrorConciliacion[] = [];
  alerts = [...new Map(traceAlerts(alerts, records, params, people, inicio, fin, erroresConciliacion).map(alert => [alert.id, alert])).values()]
    .sort((a, b) => (a.fecha ?? "9999-12-31").localeCompare(b.fecha ?? "9999-12-31") || (a.hora ?? "").localeCompare(b.hora ?? "") || a.tipo.localeCompare(b.tipo) || (a.placa ?? "").localeCompare(b.placa ?? "") || a.id.localeCompare(b.id));
  const porTipo = Object.fromEntries(Object.keys(DESCRIPTIONS).map(type => [type, 0])) as Record<AlertType, number>;
  const porPlaca: ResultadoAlertas["resumen"]["porPlaca"] = {};
  for (const alert of alerts) {
    porTipo[alert.tipo]++;
    if (alert.placa) {
      const summary = porPlaca[alert.placa] ?? { totalAlertas: 0, porTipo: {} };
      summary.totalAlertas++;
      summary.porTipo[alert.tipo] = (summary.porTipo[alert.tipo] ?? 0) + 1;
      porPlaca[alert.placa] = summary;
    }
  }
  return {
    fechaGeneracion: localNow.timestamp,
    periodo: { inicio, fin },
    resumen: {
      totalAlertas: alerts.length,
      totalVehiculosConAlertas: new Set(alerts.map(alert => alert.placa).filter(Boolean)).size,
      totalDiasConAlertas: new Set(alerts.filter(alert => alert.alcance === "REPOSTAJE" || alert.alcance === "DIA").map(alert => alert.fecha).filter(Boolean)).size,
      sinHistorialSuficiente: insufficient,
      porTipo,
      porPlaca,
    },
    alertas: alerts,
    erroresLectura: errors,
    erroresConciliacion: [...new Map(erroresConciliacion.map(error => [JSON.stringify(error), error])).values()],
  };
}
