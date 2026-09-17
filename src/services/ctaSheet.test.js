import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const DIR = await mkdtemp(path.join(os.tmpdir(), 'ctasheet-test-'));
process.env.DATA_DIR = DIR;

const { CTA_PATH } = await import('../dataPaths.js');
const { crearCta, cerrarCta } = await import('./ctaStore.js');
const { filasDeCta, volcarHojaDeCierre, sheetsConfigurado } = await import('./ctaSheet.js');

after(async () => {
  await rm(DIR, { recursive: true, force: true });
});

const envOriginal = { ...process.env };
afterEach(() => {
  delete process.env.GOOGLE_CREDENTIALS_PATH;
  delete process.env.CTA_SHEET_ID;
  for (const [k, v] of Object.entries(envOriginal)) process.env[k] = v;
});

function compFixture() {
  return {
    categorias: { tanque: { nombre: 'Tanque', emoji: '🔵', orden: 1 } },
    roles: {
      'maza-pesada': { nombre: 'Maza Pesada', emoji: '🔨', categoria: 'tanque', nota: '' },
      santi: { nombre: 'Santi', emoji: '🧪', categoria: null, nota: '' },
    },
    parties: [{ nombre: 'Party 1', slots: ['maza-pesada', 'santi'] }],
  };
}

let contador = 0;
// volcarHojaDeCierre() opera sobre CTAs YA CERRADAS (ver ctaCierre.js): el
// volcado ahora pasa siempre por cerrarCta() primero, nunca sobre una activa.
async function ctaCerradaDePrueba(overrides = {}) {
  const cta = await crearCta(CTA_PATH, {
    nombre: 'Hellgate', compId: 'x', comp: compFixture(), modo: 'abierto',
    guildId: 'g', channelId: `chan-${contador++}`, creadorId: 'off-1',
    roleId: 'role-1', roleNombre: 'Hellgate_1908-2030',
    cierraEn: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  });
  return cerrarCta(CTA_PATH, cta.id, { razon: 'manual' });
}

test('filasDeCta: cabecera + una fila por inscrito, con rol/party vacíos si no está asignado', () => {
  const cta = {
    comp: compFixture(),
    inscritos: [
      { userId: 'u1', nombre: 'Ana', roles: ['maza-pesada', 'santi'], preferido: 'maza-pesada', tentativo: false },
      { userId: 'u2', nombre: 'Bea', roles: ['santi'], preferido: 'santi', tentativo: true },
    ],
    asignaciones: { '0:0': { userId: 'u1' } },
  };

  const filas = filasDeCta(cta);
  assert.deepEqual(filas[0], ['Nombre', 'Rol asignado', 'Party', 'Roles que puede jugar', 'Tentativo']);
  assert.deepEqual(filas[1], ['Ana', 'Maza Pesada', 'Party 1', 'Maza Pesada, Santi', 'No']);
  assert.deepEqual(filas[2], ['Bea', '', '', 'Santi', 'Sí']);
});

test('sheetsConfigurado: false si falta alguna variable de entorno', () => {
  assert.equal(sheetsConfigurado(), false);
  process.env.GOOGLE_CREDENTIALS_PATH = '/x.json';
  assert.equal(sheetsConfigurado(), false);
  process.env.CTA_SHEET_ID = 'sheet-1';
  assert.equal(sheetsConfigurado(), true);
});

test('volcarHojaDeCierre: sin configurar, es un no-op silencioso (omitido: true)', async () => {
  const cta = await ctaCerradaDePrueba();
  const resultado = await volcarHojaDeCierre(cta);
  assert.deepEqual(resultado, { omitido: true });
});

test('volcarHojaDeCierre: crea la pestaña con el nombre del rol de Discord (misma convención) y escribe el bloque', async () => {
  process.env.GOOGLE_CREDENTIALS_PATH = '/x.json';
  process.env.CTA_SHEET_ID = 'sheet-1';

  const llamadasCrear = [];
  const llamadasEscribir = [];
  const impls = {
    crearPestanaImpl: async (spreadsheetId, nombre) => {
      llamadasCrear.push({ spreadsheetId, nombre });
      return nombre;
    },
    escribirBloqueImpl: async (spreadsheetId, tabName, filas) => {
      llamadasEscribir.push({ spreadsheetId, tabName, filas });
    },
  };

  const cta = await ctaCerradaDePrueba();

  const resultado = await volcarHojaDeCierre(cta, impls);
  assert.deepEqual(resultado, { omitido: false, tabName: 'Hellgate_1908-2030' });
  assert.equal(llamadasCrear.length, 1);
  assert.equal(llamadasCrear[0].nombre, 'Hellgate_1908-2030');
  assert.equal(llamadasEscribir.length, 1);
  assert.equal(llamadasEscribir[0].tabName, 'Hellgate_1908-2030');
});

test('volcarHojaDeCierre: si ya trae sheetTabName (reintento tras un fallo de escritura previo), no vuelve a crear la pestaña', async () => {
  process.env.GOOGLE_CREDENTIALS_PATH = '/x.json';
  process.env.CTA_SHEET_ID = 'sheet-1';

  const llamadasCrear = [];
  const llamadasEscribir = [];
  const impls = {
    crearPestanaImpl: async (spreadsheetId, nombre) => {
      llamadasCrear.push({ spreadsheetId, nombre });
      return nombre;
    },
    escribirBloqueImpl: async (spreadsheetId, tabName, filas) => {
      llamadasEscribir.push({ spreadsheetId, tabName, filas });
    },
  };

  const cta = await ctaCerradaDePrueba();
  cta.sheetTabName = 'Hellgate_1908-2030';

  const resultado = await volcarHojaDeCierre(cta, impls);
  assert.deepEqual(resultado, { omitido: false, tabName: 'Hellgate_1908-2030' });
  assert.equal(llamadasCrear.length, 0, 'no debe recrear una pestaña que ya existía');
  assert.equal(llamadasEscribir.length, 1);
});

test('volcarHojaDeCierre: si falla la escritura tras crear la pestaña, el error lleva el tabName ya creado', async () => {
  process.env.GOOGLE_CREDENTIALS_PATH = '/x.json';
  process.env.CTA_SHEET_ID = 'sheet-1';

  const impls = {
    crearPestanaImpl: async () => 'Hellgate_1908-2030',
    escribirBloqueImpl: async () => {
      throw new Error('boom');
    },
  };

  const cta = await ctaCerradaDePrueba();

  await assert.rejects(
    () => volcarHojaDeCierre(cta, impls),
    (error) => {
      assert.equal(error.message, 'boom');
      assert.equal(error.tabName, 'Hellgate_1908-2030');
      return true;
    },
  );
});
