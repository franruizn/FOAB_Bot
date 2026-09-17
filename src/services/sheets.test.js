import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearPestana, asegurarPestanaExacta, escribirBloqueCompleto, SheetsError } from './sheets.js';

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
