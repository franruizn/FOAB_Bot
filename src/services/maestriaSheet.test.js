import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { filasDeMaestria, sincronizarMaestriaHoja } from './maestriaSheet.js';

const envOriginal = { ...process.env };
afterEach(() => {
  delete process.env.GOOGLE_CREDENTIALS_PATH;
  delete process.env.CTA_SHEET_ID;
  for (const [k, v] of Object.entries(envOriginal)) process.env[k] = v;
});

function maestriaFixture() {
  return {
    version: 1,
    jugadores: {
      u1: { nombre: 'Zoe', roles: { santi: 5, 'maza-pesada': 2 }, ultimo: {} },
      u2: { nombre: 'Ana', roles: { santi: 3 }, ultimo: {} },
    },
    historialRoles: {},
  };
}

test('filasDeMaestria: aviso de cabecera + fila de columnas + una fila por jugador, ordenados por nombre', () => {
  const filas = filasDeMaestria(maestriaFixture());

  assert.match(filas[0][0], /reescribe por completo/);
  assert.deepEqual(filas[1], ['Jugador', 'maza-pesada', 'santi', 'Total']);
  // Ana antes que Zoe (orden alfabético), no por orden de inserción.
  assert.deepEqual(filas[2], ['Ana', '0', '3', '3']);
  assert.deepEqual(filas[3], ['Zoe', '2', '5', '7']);
});

test('filasDeMaestria: sin jugadores, solo aviso + cabecera vacía', () => {
  const filas = filasDeMaestria({ jugadores: {} });
  assert.deepEqual(filas[1], ['Jugador', 'Total']);
  assert.equal(filas.length, 2);
});

test('sincronizarMaestriaHoja: sin configurar, no-op (omitido: true)', async () => {
  const resultado = await sincronizarMaestriaHoja(maestriaFixture());
  assert.deepEqual(resultado, { omitido: true });
});

test('sincronizarMaestriaHoja: configurado, asegura la pestaña y reescribe el bloque', async () => {
  process.env.GOOGLE_CREDENTIALS_PATH = '/x.json';
  process.env.CTA_SHEET_ID = 'sheet-1';

  const llamadasAsegurar = [];
  const llamadasEscribir = [];
  const resultado = await sincronizarMaestriaHoja(maestriaFixture(), {
    asegurarPestanaImpl: async (spreadsheetId, nombre) => llamadasAsegurar.push({ spreadsheetId, nombre }),
    escribirBloqueImpl: async (spreadsheetId, nombre, filas) => llamadasEscribir.push({ spreadsheetId, nombre, filas }),
  });

  assert.deepEqual(resultado, { omitido: false });
  assert.deepEqual(llamadasAsegurar[0], { spreadsheetId: 'sheet-1', nombre: 'Maestría' });
  assert.equal(llamadasEscribir[0].nombre, 'Maestría');
  assert.equal(llamadasEscribir[0].filas.length, 4); // aviso + cabecera + 2 jugadores
});
