import assert from "node:assert/strict";
import { test } from "node:test";
import { consolidarAlertas, currentMonthPeriod, normalizeDate, normalizeTime, type AlertasData, type SheetValue } from "../src/alertas-rules.ts";

const matrixHeader = ["TELF", "KILOMETRAJE", "COMBUSTIBLE", "FECHA", "HORA", "Precio por Galón", "Galones", "Tipo de Combustible", "Valor de la Recarga", "PLACA", "RUC ESTACIÓN", "ESTACIÓN DE SERVICIO", "NÚMERO DE FACTURA", "FECHA FACTURA", "HORA FACTURA", "SUBTOTAL", "IVA", "KILOMETRAJE ANTERIOR", "DIFERENCIA KILOMETRAJE"];
const calendarHeader = ["FECHA", "DIA_SEMANA", "REPOSTADORES", "REPOSTADORES_FUERA_DE_JORNADA", "REPOSTADORES_MAS_DE_UN_REPOSTAJE", "REPOSTADORES_PICO_RECARGA", "VALIDADOR VIERNES", "VALIDADOR JORNADA", "VALIDADOR MAS DE UN REPOSTAJE", "VALIDADOR_PICO_RECARGA"];
const indicatorHeader = ["", "", "", "EMPLEADO", "PLACA", "KM INICIAL", "KM FINAL", "KM RECORRIDOS", "VALIDADOR KMAJE", "GALONES", "KM / GALÓN", "KM / DÓLAR", "COSTO POR KM"];

function matrixRow(fecha: string, hora: string, valor: number, km: number): SheetValue[] {
  const row: SheetValue[] = Array(19).fill("");
  row[1] = km; row[3] = fecha; row[4] = hora; row[7] = "Extra";
  row[8] = valor; row[9] = "GBA-1234"; row[11] = "Estación Centro"; row[12] = `FACT-${fecha}-${hora}`;
  return row;
}

function fixture(budget = 100, withFuture = false): AlertasData {
  const parametros: SheetValue[][] = [
    ["INICIO PERIODO", "2026-11-01"], ["FIN PERIODO", "2026-11-06"],
    ["TIPO DE COMBUSTIBLE", "TODOS"], ["ESTACIÓN DE SERVICIO", "TODOS"],
    ["PRESUPUESTO MENSUAL", budget], ["LÍMITE KM MÍNIMO", 400], ["LÍMITE KM MÁXIMO", 450],
    ["HORA INICIO JORNADA", 0.25], ["HORA FIN JORNADA", 17 / 24], ["UMBRAL_PICO_RECARGA", 0.6],
  ];
  const matriz = [matrixHeader, ...[20, 21, 22, 23, 24].map(day => matrixRow(`2026-10-${day}`, "10:00", 10, 500)),
    matrixRow("2026-11-06", "18:30", 20, 1000), matrixRow("2026-11-06", "19:00", 10, 1480)];
  if (withFuture) matriz.push(matrixRow("2026-12-01", "18:30", 1000, 3000));
  const calendario: SheetValue[][] = [
    ...Array.from({ length: 8 }, () => []), calendarHeader,
    ["2026-11-06", "VIERNES", "GBA-1234, GBA-1234", "GBA-1234", "GBA-1234", "GBA-1234", "SALVEDAD", "SALVEDAD", "SALVEDAD", "SALVEDAD"],
  ];
  const indicadores: SheetValue[][] = Array.from({ length: 37 }, () => []);
  indicadores[12] = ["GASTO TOTAL", 120];
  indicadores[21] = ["VALIDADOR PRESUPUESTO", "DESCUADRE"];
  indicadores.push(indicatorHeader, ["", "", "", "PEPE UNO", "GBA-1234", 1000, 1430, 430, "EN EL LIMITE"]);
  const promedios: SheetValue[][] = [
    ["FECHA", "HORA", "PLACA", "VALOR RECARGA", "RECARGAS ANTERIORES", "PROMEDIO ÚLTIMAS 5", "LÍMITE PERMITIDO", "ESTADO"],
    ["2026-11-06", "18:30", "GBA-1234", 20, 5, 10, 16, "SALVEDAD"],
    ["2026-11-06", "19:00", "GBA-1234", 10, 4, "", "", "SIN HISTORIAL SUFICIENTE"],
  ];
  return { parametros, matriz, personas: [["TELF", "NOMBRE", "PLACA"], ["593999999999", "PEPE UNO", "GBA-1234"]], calendario, indicadores, promedios };
}

const now = new Date("2026-11-07T12:00:00.000Z");

test("normaliza fechas seriales, fechas formateadas y horas fraccionarias", () => {
  assert.equal(normalizeDate(46327), "2026-11-01");
  assert.equal(normalizeDate("06/11/2026"), "2026-11-06");
  assert.equal(normalizeDate("2026-11-06T02:00:00Z"), "2026-11-05");
  assert.equal(normalizeTime(17 / 24), "17:00");
  assert.equal(normalizeTime("6:30 PM"), "18:30");
  assert.deepEqual(currentMonthPeriod(new Date("2026-11-13T03:00:00Z")), { inicio: "2026-11-01", fin: "2026-11-30" });
});

test("consolida validadores de hojas sin duplicar placas ni el pico del Calendario", () => {
  const result = consolidarAlertas(fixture(), {}, now);
  assert.equal(result.resumen.totalAlertas, 7);
  assert.equal(result.resumen.totalVehiculosConAlertas, 1);
  assert.equal(result.resumen.totalDiasConAlertas, 1);
  assert.equal(result.resumen.porTipo.REPOSTAJE_VIERNES, 1);
  assert.equal(result.resumen.porTipo.FUERA_DE_JORNADA, 2);
  assert.equal(result.resumen.porTipo.MULTIPLES_REPOSTAJES, 1);
  assert.equal(result.resumen.porTipo.PICO_RECARGA, 1);
  assert.equal(result.resumen.porTipo.KILOMETRAJE_EN_LIMITE, 1);
  assert.equal(result.resumen.porTipo.PRESUPUESTO_EXCEDIDO, 1);
  assert.equal(result.resumen.sinHistorialSuficiente, 1);
  assert.equal(result.alertas.find(alert => alert.tipo === "PICO_RECARGA")?.origen, "PROMEDIOS_REPOSTAJE");
  assert.equal(result.alertas.find(alert => alert.tipo === "MULTIPLES_REPOSTAJES")?.repostajes?.length, 2);
  assert.deepEqual(result.alertas.filter(alert => alert.tipo === "FUERA_DE_JORNADA").map(alert => alert.hora), ["18:30", "19:00"]);
  assert.equal(result.resumen.porPlaca["GBA-1234"].totalAlertas, 6);
  assert.equal(result.alertas.find(alert => alert.tipo === "PRESUPUESTO_EXCEDIDO")?.alcance, "GLOBAL");
  assert.equal(result.alertas.find(alert => alert.tipo === "KILOMETRAJE_EN_LIMITE")?.repostajes?.length, 2);
});

test("recalcula un período personalizado con cinco recargas anteriores fuera del período", () => {
  const result = consolidarAlertas(fixture(25), { fechaInicio: "2026-11-02", fechaFin: "2026-11-06" }, now);
  assert.equal(result.resumen.porTipo.PICO_RECARGA, 1);
  assert.equal(result.resumen.porTipo.KILOMETRAJE_EXCEDIDO, 1);
  assert.equal(result.resumen.porTipo.KILOMETRAJE_EN_LIMITE, 0);
  assert.equal(result.resumen.porTipo.PRESUPUESTO_EXCEDIDO, 1);
  const peak = result.alertas.find(alert => alert.tipo === "PICO_RECARGA");
  assert.equal(peak?.origen, "Matriz");
  assert.equal(peak?.detalles.promedioUltimas5, 10);
  assert.equal(peak?.detalles.limitePermitido, 16);
});

test("excluye registros posteriores al fin solicitado y rechaza períodos inválidos", () => {
  const result = consolidarAlertas(fixture(100, true), { fechaFin: "2026-11-25" }, now);
  assert.equal(result.alertas.some(alert => alert.fecha === "2026-12-01"), false);
  assert.equal(result.resumen.porTipo.PRESUPUESTO_EXCEDIDO, 0);
  assert.throws(() => consolidarAlertas(fixture(), { fechaInicio: "2026-11-26", fechaFin: "2026-11-01" }, now), /Período inválido/);
});

test("concilia diez repostajes de noviembre con nueve alertas y referencias exactas", () => {
  const data = fixture(400);
  data.parametros[1][1] = "2026-11-30";
  data.parametros[5][1] = 4000;
  data.parametros[6][1] = 4500;
  const entries: Array<[string, string, string, number, number, string]> = [
    ["TEST-001", "2026-11-02", "08:00", 10000, 27.4, "TEST-001-000001"],
    ["TEST-001", "2026-11-04", "09:00", 10800, 27.4, "TEST-001-000002"],
    ["TEST-001", "2026-11-06", "10:00", 11600, 27.4, "TEST-001-000003"],
    ["TEST-001", "2026-11-09", "05:30", 12400, 27.4, "TEST-001-000004"],
    ["TEST-001", "2026-11-11", "11:00", 13200, 27.4, "TEST-001-000005"],
    ["TEST-001", "2026-11-13", "12:00", 14000, 180, "TEST-001-000006"],
    ["TEST-001", "2026-11-25", "10:00", 14800, 27.4, "TEST-001-000007"],
    ["TEST-002", "2026-11-16", "08:00", 20000, 27.4, "TEST-001-000008"],
    ["TEST-002", "2026-11-16", "15:00", 20400, 27.4, "TEST-001-000009"],
    ["TEST-002", "2026-11-20", "19:00", 20800, 27.4, "TEST-001-000010"],
  ];
  data.matriz = [matrixHeader, ...entries.map(([plate, date, time, km, amount, invoice]) => {
    const row = matrixRow(date, time, amount, km);
    row[9] = plate; row[12] = invoice;
    return row;
  })];
  data.personas = [["TELF", "NOMBRE", "PLACA"], ["", "USER PRUEBA", "TEST-001"], ["", "USER PRUEBA", "TEST-002"]];
  data.calendario = [...Array.from({ length: 8 }, () => []), calendarHeader,
    ["2026-11-06", "VIERNES", "TEST-001", "", "", "", "SALVEDAD", "OK", "OK", "OK"],
    ["2026-11-09", "LUNES", "", "TEST-001", "", "", "OK", "SALVEDAD", "OK", "OK"],
    ["2026-11-13", "VIERNES", "TEST-001", "", "", "TEST-001", "SALVEDAD", "OK", "OK", "SALVEDAD"],
    ["2026-11-16", "LUNES", "", "", "TEST-002", "", "OK", "OK", "SALVEDAD", "OK"],
    ["2026-11-20", "VIERNES", "TEST-002", "TEST-002", "", "", "SALVEDAD", "SALVEDAD", "OK", "OK"],
  ];
  data.indicadores[12] = ["GASTO TOTAL", 426.6];
  data.indicadores[38] = ["", "", "", "USER PRUEBA", "TEST-001", 10000, 14800, 4800, "EXCEDIO"];
  data.indicadores.push(["", "", "", "USER PRUEBA", "TEST-002", 20000, 20800, 800, "OK"]);
  data.promedios = [data.promedios[0], ["2026-11-13", "12:00", "TEST-001", 180, 5, 27.4, 43.84, "SALVEDAD"]];

  const result = consolidarAlertas(data, { fechaInicio: "2026-11-01", fechaFin: "2026-11-30" }, new Date("2026-11-13T12:00:00Z"));
  assert.equal(result.resumen.totalAlertas, 9);
  assert.deepEqual(result.resumen.porTipo, {
    REPOSTAJE_VIERNES: 3, FUERA_DE_JORNADA: 2, MULTIPLES_REPOSTAJES: 1, PICO_RECARGA: 1,
    KILOMETRAJE_EN_LIMITE: 0, KILOMETRAJE_EXCEDIDO: 1, PRESUPUESTO_EXCEDIDO: 1,
  });
  assert.deepEqual(result.erroresConciliacion, []);
  const outside = result.alertas.find(alert => alert.tipo === "FUERA_DE_JORNADA" && alert.placa === "TEST-001");
  assert.equal(outside?.hora, "05:30");
  assert.equal(outside?.repostajes?.[0].numeroFactura, "TEST-001-000004");
  const peak = result.alertas.find(alert => alert.tipo === "PICO_RECARGA");
  const friday = result.alertas.find(alert => alert.tipo === "REPOSTAJE_VIERNES" && alert.fecha === "2026-11-13");
  assert.equal(peak?.repostajes?.[0].idRegistro, friday?.repostajes?.[0].idRegistro);
  assert.equal(peak?.detalles.porcentajeExceso, (180 / 43.84 - 1) * 100);
  const multiple = result.alertas.find(alert => alert.tipo === "MULTIPLES_REPOSTAJES");
  assert.deepEqual(multiple?.repostajes?.map(record => record.hora), ["08:00", "15:00"]);
  const mileage = result.alertas.find(alert => alert.tipo === "KILOMETRAJE_EXCEDIDO");
  assert.equal(mileage?.detalles.kmRecorridos, 4800);
  assert.equal(mileage?.repostajes?.length, 7);
  const budget = result.alertas.find(alert => alert.tipo === "PRESUPUESTO_EXCEDIDO");
  assert.equal(budget?.detalles.gastoTotal, 426.6);
  assert.equal(budget?.detalles.excesoDolares, 26.6);
  assert.equal(budget?.repostajes?.length, 10);
});

test("reporta un pico ambiguo sin elegir una factura por el orden de las filas", () => {
  const data = fixture();
  const duplicate = matrixRow("2026-11-06", "18:30", 20, 1001);
  duplicate[12] = "OTRA-FACTURA";
  data.matriz.push(duplicate);
  const result = consolidarAlertas(data, {}, now);
  assert.equal(result.resumen.porTipo.PICO_RECARGA, 0);
  assert.match(result.erroresConciliacion.find(error => error.tipo === "PICO_RECARGA")?.motivo ?? "", /ambiguo/);
  const friday = result.alertas.find(alert => alert.tipo === "REPOSTAJE_VIERNES");
  assert.equal(friday?.repostajes?.length, 3);
  assert.notEqual(friday?.repostajes?.[0].idRegistro, friday?.repostajes?.[2].idRegistro);
});

test("reporta la falta de un repostaje original sin fabricarlo", () => {
  const data = fixture();
  data.matriz = data.matriz.filter(row => row[4] !== "18:30");
  const result = consolidarAlertas(data, {}, now);
  assert.equal(result.resumen.porTipo.PICO_RECARGA, 0);
  assert.match(result.erroresConciliacion.find(error => error.tipo === "PICO_RECARGA")?.motivo ?? "", /No se encontr/);
});
