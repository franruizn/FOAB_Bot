import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  crearPestana,
  asegurarPestanaExacta,
  escribirBloqueCompleto,
  obtenerMetadatosHoja,
  obtenerEmailDeServicio,
  validarCredenciales,
  resetAuthParaTests,
  SheetsError,
} from './sheets.js';

const DIR = await mkdtemp(path.join(os.tmpdir(), 'sheets-test-'));
after(async () => {
  await rm(DIR, { recursive: true, force: true });
});

async function conCredencialesDePrueba(fn) {
  const credsFile = path.join(DIR, `creds-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(
    credsFile,
    JSON.stringify({
      type: 'service_account',
      project_id: 'proyecto-de-prueba',
      client_email: 'foab-bot@proyecto-de-prueba.iam.gserviceaccount.com',
      private_key:
        '-----BEGIN PRIVATE KEY-----\nMIIFAKEKEYFORTESTINGPURPOSESONLYnotarealkey\n-----END PRIVATE KEY-----\n',
    }),
    'utf8',
  );

  const originalCreds = process.env.GOOGLE_CREDENTIALS_PATH;
  const originalSheet = process.env.CTA_SHEET_ID;
  process.env.GOOGLE_CREDENTIALS_PATH = credsFile;
  process.env.CTA_SHEET_ID = 'sheet-1';
  resetAuthParaTests();
  try {
    await fn();
  } finally {
    if (originalCreds === undefined) delete process.env.GOOGLE_CREDENTIALS_PATH;
    else process.env.GOOGLE_CREDENTIALS_PATH = originalCreds;
    if (originalSheet === undefined) delete process.env.CTA_SHEET_ID;
    else process.env.CTA_SHEET_ID = originalSheet;
    resetAuthParaTests();
  }
}

const tokenImpl = async () => 'token-de-prueba';

function fetchQueDevuelve(respuestas) {
  const llamadas = [];
  let i = 0;
  return {
    llamadas,
    async fetch(url, init) {
      llamadas.push({ url, init });
      const r = respuestas[Math.min(i, respuestas.length - 1)];
      i += 1;
      return r;
    },
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

test('crearPestana: con un 200, devuelve el título creado', async () => {
  const { fetch: fetchImpl, llamadas } = fetchQueDevuelve([
    jsonResponse(200, { replies: [{ addSheet: { properties: { title: 'Hellgate 20h' } } }] }),
  ]);

  const titulo = await crearPestana('sheet-1', 'Hellgate 20h', { fetchImpl, tokenImpl });
  assert.equal(titulo, 'Hellgate 20h');
  assert.match(llamadas[0].url, /:batchUpdate$/);
});

test('crearPestana: si el nombre choca (400), reintenta con sufijos hasta que uno funciona', async () => {
  const { fetch: fetchImpl } = fetchQueDevuelve([
    jsonResponse(400, { error: 'ya existe' }),
    jsonResponse(400, { error: 'ya existe' }),
    jsonResponse(200, { replies: [{ addSheet: { properties: { title: 'Hellgate (3)' } } }] }),
  ]);

  const titulo = await crearPestana('sheet-1', 'Hellgate', { fetchImpl, tokenImpl });
  assert.equal(titulo, 'Hellgate (3)');
});

test('crearPestana: sanea caracteres inválidos del nombre', async () => {
  const { fetch: fetchImpl, llamadas } = fetchQueDevuelve([
    jsonResponse(200, { replies: [{ addSheet: { properties: { title: 'Hellgate 20 09' } } }] }),
  ]);

  await crearPestana('sheet-1', 'Hellgate [20/09]: *prueba*', { fetchImpl, tokenImpl });
  const body = JSON.parse(llamadas[0].init.body);
  assert.equal(body.requests[0].addSheet.properties.title, 'Hellgate 2009 prueba');
});

test('crearPestana: un error que no es 400 se propaga sin reintentar', async () => {
  const { fetch: fetchImpl, llamadas } = fetchQueDevuelve([jsonResponse(500, { error: 'boom' })]);
  await assert.rejects(
    () => crearPestana('sheet-1', 'Hellgate', { fetchImpl, tokenImpl }),
    SheetsError,
  );
  assert.equal(llamadas.length, 1);
});

test('asegurarPestanaExacta: con un 200, crea la pestaña', async () => {
  const { fetch: fetchImpl, llamadas } = fetchQueDevuelve([jsonResponse(200, {})]);
  await assert.doesNotReject(() => asegurarPestanaExacta('sheet-1', 'Maestría', { fetchImpl, tokenImpl }));
  assert.equal(llamadas.length, 1);
});

test('asegurarPestanaExacta: si ya existe (400), lo trata como éxito, sin reintentar con sufijos', async () => {
  const { fetch: fetchImpl, llamadas } = fetchQueDevuelve([jsonResponse(400, { error: 'ya existe' })]);
  await assert.doesNotReject(() => asegurarPestanaExacta('sheet-1', 'Maestría', { fetchImpl, tokenImpl }));
  assert.equal(llamadas.length, 1); // ni un segundo intento con "(2)"
});

test('asegurarPestanaExacta: un error que no es 400 se propaga', async () => {
  const { fetch: fetchImpl } = fetchQueDevuelve([jsonResponse(500, { error: 'boom' })]);
  await assert.rejects(() => asegurarPestanaExacta('sheet-1', 'Maestría', { fetchImpl, tokenImpl }), SheetsError);
});

test('escribirBloqueCompleto: con auth y fetch simulados, un 200 limpia y escribe sin lanzar', async () => {
  const { fetch: fetchImpl, llamadas } = fetchQueDevuelve([
    jsonResponse(200, {}),
    jsonResponse(200, {}),
  ]);

  await escribirBloqueCompleto('sheet-1', 'Hellgate 20h', [['nombre', 'rol']], { fetchImpl, tokenImpl });

  assert.equal(llamadas.length, 2);
  assert.match(llamadas[0].url, /:clear$/);
  assert.equal(llamadas[0].init.method, 'POST');
  assert.match(llamadas[1].url, /valueInputOption=RAW$/);
  assert.equal(llamadas[1].init.method, 'PUT');
  assert.deepEqual(JSON.parse(llamadas[1].init.body).values, [['nombre', 'rol']]);
});

test('escribirBloqueCompleto: escapa comillas simples del nombre de pestaña en el rango', async () => {
  const { fetch: fetchImpl, llamadas } = fetchQueDevuelve([jsonResponse(200, {}), jsonResponse(200, {})]);
  await escribirBloqueCompleto('sheet-1', "Party's CTA", [['a']], { fetchImpl, tokenImpl });
  assert.match(llamadas[0].url, /Party''s CTA/);
});

test('escribirBloqueCompleto: si falla el clear, lanza SheetsError y no intenta escribir', async () => {
  const { fetch: fetchImpl, llamadas } = fetchQueDevuelve([jsonResponse(403, { error: 'sin permiso' })]);
  await assert.rejects(
    () => escribirBloqueCompleto('sheet-1', 'Hellgate', [['a']], { fetchImpl, tokenImpl }),
    SheetsError,
  );
  assert.equal(llamadas.length, 1);
});

test('obtenerMetadatosHoja: con un 200, devuelve el título; es un GET, nunca escribe', async () => {
  const { fetch: fetchImpl, llamadas } = fetchQueDevuelve([jsonResponse(200, { properties: { title: 'Mi Hoja' } })]);
  const resultado = await obtenerMetadatosHoja('sheet-1', { fetchImpl, tokenImpl });
  assert.deepEqual(resultado, { titulo: 'Mi Hoja' });
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].init.method, 'GET');
  assert.match(llamadas[0].url, /^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/sheet-1\?fields=properties\.title$/);
});

test('obtenerMetadatosHoja: 401/403 (credenciales/permiso) o 404 (id mal) se propagan como SheetsError', async () => {
  const { fetch: fetchImpl } = fetchQueDevuelve([jsonResponse(403, { error: 'sin permiso' })]);
  await assert.rejects(
    () => obtenerMetadatosHoja('sheet-1', { fetchImpl, tokenImpl }),
    (error) => {
      assert.ok(error instanceof SheetsError);
      assert.equal(error.status, 403);
      return true;
    },
  );
});

test('obtenerEmailDeServicio: lee el client_email del JSON de credenciales, sin llamadas de red', async () => {
  const credsFile = path.join(DIR, 'creds.json');
  await writeFile(
    credsFile,
    JSON.stringify({
      type: 'service_account',
      project_id: 'proyecto-de-prueba',
      client_email: 'foab-bot@proyecto-de-prueba.iam.gserviceaccount.com',
      private_key:
        '-----BEGIN PRIVATE KEY-----\nMIIFAKEKEYFORTESTINGPURPOSESONLYnotarealkey\n-----END PRIVATE KEY-----\n',
    }),
    'utf8',
  );

  const original = process.env.GOOGLE_CREDENTIALS_PATH;
  process.env.GOOGLE_CREDENTIALS_PATH = credsFile;
  resetAuthParaTests();
  try {
    const email = await obtenerEmailDeServicio();
    assert.equal(email, 'foab-bot@proyecto-de-prueba.iam.gserviceaccount.com');
  } finally {
    if (original === undefined) delete process.env.GOOGLE_CREDENTIALS_PATH;
    else process.env.GOOGLE_CREDENTIALS_PATH = original;
    resetAuthParaTests();
  }
});

test('obtenerEmailDeServicio: sin GOOGLE_CREDENTIALS_PATH, lanza SheetsError', async () => {
  const original = process.env.GOOGLE_CREDENTIALS_PATH;
  delete process.env.GOOGLE_CREDENTIALS_PATH;
  resetAuthParaTests();
  try {
    await assert.rejects(() => obtenerEmailDeServicio(), SheetsError);
  } finally {
    if (original !== undefined) process.env.GOOGLE_CREDENTIALS_PATH = original;
    resetAuthParaTests();
  }
});

test('validarCredenciales: "sin-configurar" si faltan GOOGLE_CREDENTIALS_PATH y/o CTA_SHEET_ID', async () => {
  const originalCreds = process.env.GOOGLE_CREDENTIALS_PATH;
  const originalSheet = process.env.CTA_SHEET_ID;
  delete process.env.GOOGLE_CREDENTIALS_PATH;
  delete process.env.CTA_SHEET_ID;
  try {
    assert.deepEqual(await validarCredenciales(), { result: 'sin-configurar' });
  } finally {
    if (originalCreds !== undefined) process.env.GOOGLE_CREDENTIALS_PATH = originalCreds;
    if (originalSheet !== undefined) process.env.CTA_SHEET_ID = originalSheet;
  }
});

test('validarCredenciales: "error" en la etapa "login" si las credenciales no cargan', async () => {
  const originalCreds = process.env.GOOGLE_CREDENTIALS_PATH;
  const originalSheet = process.env.CTA_SHEET_ID;
  process.env.GOOGLE_CREDENTIALS_PATH = path.join(DIR, 'no-existe.json');
  process.env.CTA_SHEET_ID = 'sheet-1';
  resetAuthParaTests();
  try {
    const resultado = await validarCredenciales();
    assert.equal(resultado.result, 'error');
    assert.equal(resultado.etapa, 'login');
    assert.ok(resultado.mensaje);
  } finally {
    if (originalCreds === undefined) delete process.env.GOOGLE_CREDENTIALS_PATH;
    else process.env.GOOGLE_CREDENTIALS_PATH = originalCreds;
    if (originalSheet === undefined) delete process.env.CTA_SHEET_ID;
    else process.env.CTA_SHEET_ID = originalSheet;
    resetAuthParaTests();
  }
});

test('validarCredenciales: "error" en la etapa "acceso" si el login va bien pero la hoja no responde 200', async () => {
  await conCredencialesDePrueba(async () => {
    const { fetch: fetchImpl } = fetchQueDevuelve([jsonResponse(403, { error: 'sin permiso' })]);
    const resultado = await validarCredenciales({ fetchImpl, tokenImpl });

    assert.equal(resultado.result, 'error');
    assert.equal(resultado.etapa, 'acceso');
    assert.equal(resultado.email, 'foab-bot@proyecto-de-prueba.iam.gserviceaccount.com');
    assert.equal(resultado.status, 403);
  });
});

test('validarCredenciales: "ok" con email y título cuando login y acceso van bien', async () => {
  await conCredencialesDePrueba(async () => {
    const { fetch: fetchImpl } = fetchQueDevuelve([jsonResponse(200, { properties: { title: 'FOAB CTAs' } })]);
    const resultado = await validarCredenciales({ fetchImpl, tokenImpl });

    assert.deepEqual(resultado, {
      result: 'ok',
      email: 'foab-bot@proyecto-de-prueba.iam.gserviceaccount.com',
      titulo: 'FOAB CTAs',
    });
  });
});
