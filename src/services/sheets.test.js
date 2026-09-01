import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// DATA_DIR tiene que fijarse ANTES de importar sheets.js: ahora importa
// dataPaths.js transitivamente (por CTA_SHEET_CONFIG_PATH), y sin esto
// usaría el DATA_DIR real del proyecto (./data) sin querer.
const TEST_DATA_DIR = path.join(os.tmpdir(), `sheets-test-data-${Date.now()}`);
process.env.DATA_DIR = TEST_DATA_DIR;

const {
  SheetsError,
  columnLetterToIndex,
  indexToColumnLetter,
  parseCellRef,
  quoteSheetName,
  fetchWithRetry,
  escribirBloque,
  limpiarBloque,
  validarCredencialesSheetsAlArrancar,
  __setRetryDelaysForTests,
  __setAuthStateForTests,
} = await import('./sheets.js');
const { setSheetIdOverride, setSheetTabOverride, setRangoInicioOverride } = await import('./ctaSheetConfig.js');
const { CTA_SHEET_CONFIG_PATH } = await import('../dataPaths.js');

// Los reintentos de fetchWithRetry() usan un backoff real de hasta 1+2+4=7s.
// En la suite no aporta nada esperar eso de verdad: se prueba la LÓGICA
// (cuántas veces reintenta, con qué códigos), no el reloj.
before(() => {
  __setRetryDelaysForTests([0, 0, 0]);
});

after(async () => {
  __setRetryDelaysForTests(null); // restaura el backoff real (por si algo más importa este módulo)
  __setAuthStateForTests(null);
  await rm(TEST_DATA_DIR, { recursive: true, force: true });
});

// ============================================================
// Notación A1: aritmética pura, sin red ni credenciales.
// ============================================================

test('columnLetterToIndex()/indexToColumnLetter() contra pares conocidos y roundtrip', () => {
  const pares = [
    ['A', 1],
    ['Z', 26],
    ['AA', 27],
    ['AZ', 52],
    ['BA', 53],
    ['P', 16],
    ['S', 19],
  ];
  for (const [letras, indice] of pares) {
    assert.equal(columnLetterToIndex(letras), indice);
    assert.equal(indexToColumnLetter(indice), letras);
  }
  for (let i = 1; i <= 100; i++) {
    assert.equal(columnLetterToIndex(indexToColumnLetter(i)), i);
  }
});

test('P + 4 columnas (nombre, rol1, rol2, rol3) termina en S — el caso real del bloque de CTA', () => {
  const inicio = columnLetterToIndex('P');
  const fin = indexToColumnLetter(inicio + 4 - 1);
  assert.equal(fin, 'S');
});

test('parseCellRef() acepta minúsculas/espacios y rechaza formatos inválidos', () => {
  assert.deepEqual(parseCellRef('P3'), { column: 'P', row: 3 });
  assert.deepEqual(parseCellRef(' p3 '), { column: 'P', row: 3 });
  assert.deepEqual(parseCellRef('AA100'), { column: 'AA', row: 100 });
  assert.throws(() => parseCellRef('no-es-celda'), SheetsError);
  assert.throws(() => parseCellRef('3P'), SheetsError);
  assert.throws(() => parseCellRef(''), SheetsError);
});

test('quoteSheetName() cita nombres de pestaña con espacios/caracteres especiales y escapa comillas', () => {
  assert.equal(quoteSheetName('Hoja1'), 'Hoja1');
  assert.equal(quoteSheetName('CTA_2026'), 'CTA_2026');
  assert.equal(quoteSheetName('Lista CTA'), "'Lista CTA'");
  assert.equal(quoteSheetName("O'Brien"), "'O''Brien'");
});

// ============================================================
// Validación de entrada de escribirBloque()/limpiarBloque(): se comprueba
// ANTES de tocar ninguna variable de entorno o red.
// ============================================================

test('escribirBloque() rechaza una fila con el número de columnas incorrecto, sin necesitar ninguna variable de entorno', async () => {
  const antes = { ...process.env };
  for (const key of ['GOOGLE_CREDENTIALS_PATH', 'CTA_SHEET_ID', 'CTA_SHEET_TAB', 'CTA_RANGO_INICIO']) {
    delete process.env[key];
  }
  try {
    await assert.rejects(() => escribirBloque([['nombre', 'rol1']]), (err) => {
      assert.ok(err instanceof SheetsError);
      assert.match(err.message, /tiene 2 columnas, se esperaban 4/);
      return true;
    });
  } finally {
    process.env = antes;
  }
});

test('limpiarBloque() rechaza numFilas no entero o negativo, sin necesitar ninguna variable de entorno', async () => {
  const antes = { ...process.env };
  for (const key of ['GOOGLE_CREDENTIALS_PATH', 'CTA_SHEET_ID', 'CTA_SHEET_TAB', 'CTA_RANGO_INICIO']) {
    delete process.env[key];
  }
  try {
    await assert.rejects(() => limpiarBloque(-1), SheetsError);
    await assert.rejects(() => limpiarBloque(1.5), SheetsError);
    await assert.rejects(() => limpiarBloque('3'), SheetsError);
  } finally {
    process.env = antes;
  }
});

// ============================================================
// Variables de entorno requeridas: cada una, aislada (las demás puestas a
// un valor válido), debe producir un SheetsError claro con su propio
// nombre. No llega a la red: falla antes en requireEnv()/parseCellRef().
// ============================================================

const ENV_KEYS = ['GOOGLE_CREDENTIALS_PATH', 'CTA_SHEET_ID', 'CTA_SHEET_TAB', 'CTA_RANGO_INICIO'];
let savedEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
});

function restoreEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, savedEnv);
}

test('falta cada variable de entorno requerida por separado -> SheetsError nombrándola', async () => {
  const validos = {
    GOOGLE_CREDENTIALS_PATH: '/no/hace/falta/que/exista/para/este/test.json',
    CTA_SHEET_ID: 'fake-sheet-id',
    CTA_SHEET_TAB: 'Hoja1',
    CTA_RANGO_INICIO: 'P3',
  };

  for (const missingKey of ENV_KEYS) {
    for (const key of ENV_KEYS) process.env[key] = validos[key];
    delete process.env[missingKey];

    await assert.rejects(() => limpiarBloque(1), (err) => {
      assert.ok(err instanceof SheetsError, `esperaba SheetsError faltando ${missingKey}`);
      assert.match(err.message, new RegExp(missingKey), `el mensaje debe nombrar "${missingKey}"`);
      return true;
    });
  }

  restoreEnv();
});

test('CTA_RANGO_INICIO con formato inválido -> SheetsError claro (no llega a la red)', async () => {
  process.env.GOOGLE_CREDENTIALS_PATH = '/no/existe.json';
  process.env.CTA_SHEET_ID = 'fake-sheet-id';
  process.env.CTA_SHEET_TAB = 'Hoja1';
  process.env.CTA_RANGO_INICIO = 'no-es-una-celda';

  await assert.rejects(() => limpiarBloque(1), (err) => {
    assert.ok(err instanceof SheetsError);
    assert.match(err.message, /no es una referencia de celda válida/);
    return true;
  });

  restoreEnv();
});

test('GOOGLE_CREDENTIALS_PATH apuntando a un fichero inexistente -> SheetsError claro con la ruta (falla en el disco local, no en la red)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sheets-test-'));
  const rutaInexistente = path.join(dir, 'no-existe.json');

  process.env.GOOGLE_CREDENTIALS_PATH = rutaInexistente;
  process.env.CTA_SHEET_ID = 'fake-sheet-id';
  process.env.CTA_SHEET_TAB = 'Hoja1';
  process.env.CTA_RANGO_INICIO = 'P3';

  await assert.rejects(() => limpiarBloque(1), (err) => {
    assert.ok(err instanceof SheetsError);
    assert.match(err.message, /No se pudo leer el fichero de credenciales/);
    assert.ok(err.message.includes(rutaInexistente) || err.message.includes(path.resolve(rutaInexistente)));
    return true;
  });

  restoreEnv();
  await rm(dir, { recursive: true, force: true });
});

// ============================================================
// fetchWithRetry(): reintento con backoff en 429/5xx, nunca en 403/4xx,
// con fetch simulado — sin red real.
// ============================================================

test('fetchWithRetry(): reintenta en 429 y tiene éxito', async (t) => {
  let calls = 0;
  t.mock.method(global, 'fetch', async () => {
    calls++;
    if (calls < 2) return { ok: false, status: 429, text: async () => 'rate limited' };
    return { ok: true, json: async () => ({ ok: true }) };
  });

  const result = await fetchWithRetry('https://example.test', {});
  assert.equal(calls, 2);
  assert.deepEqual(result, { ok: true });
});

test('fetchWithRetry(): reintenta en 5xx igual que en 429', async (t) => {
  let calls = 0;
  t.mock.method(global, 'fetch', async () => {
    calls++;
    if (calls < 2) return { ok: false, status: 503, text: async () => 'unavailable' };
    return { ok: true, json: async () => ({}) };
  });

  await fetchWithRetry('https://example.test', {});
  assert.equal(calls, 2);
});

test('fetchWithRetry(): NO reintenta en 403 (un solo intento)', async (t) => {
  let calls = 0;
  t.mock.method(global, 'fetch', async () => {
    calls++;
    return { ok: false, status: 403, text: async () => 'forbidden' };
  });

  await assert.rejects(() => fetchWithRetry('https://example.test', {}), (err) => {
    assert.ok(err instanceof SheetsError);
    assert.equal(err.status, 403);
    return true;
  });
  assert.equal(calls, 1);
});

test('fetchWithRetry(): NO reintenta en otro 4xx (400)', async (t) => {
  let calls = 0;
  t.mock.method(global, 'fetch', async () => {
    calls++;
    return { ok: false, status: 400, text: async () => 'bad request' };
  });

  await assert.rejects(() => fetchWithRetry('https://example.test', {}));
  assert.equal(calls, 1);
});

test('fetchWithRetry(): agota 1 intento inicial + 3 reintentos (4 llamadas) y lanza el último error', async (t) => {
  let calls = 0;
  t.mock.method(global, 'fetch', async () => {
    calls++;
    return { ok: false, status: 500, text: async () => 'still down' };
  });

  await assert.rejects(() => fetchWithRetry('https://example.test', {}), (err) => {
    assert.equal(err.status, 500);
    return true;
  });
  assert.equal(calls, 4, 'debe ser 1 intento inicial + 3 reintentos = 4 llamadas totales');
});

// ============================================================
// Credenciales explícitas (fs + JSON.parse + validación de campos), SIN
// dejar que GoogleAuth "descubra" nada: un fichero corrupto debe fallar
// rápido y en local, nunca con una llamada de red de verdad.
// ============================================================

test('GOOGLE_CREDENTIALS_PATH con JSON corrupto -> SheetsError claro y RÁPIDO (nunca cae a ADC/metadata server)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sheets-test-'));
  const rutaCorrupta = path.join(dir, 'corrupto.json');
  await writeFile(rutaCorrupta, '{ esto no es json válido', 'utf8');

  process.env.GOOGLE_CREDENTIALS_PATH = rutaCorrupta;
  process.env.CTA_SHEET_ID = 'fake-sheet-id';
  process.env.CTA_SHEET_TAB = 'Hoja1';
  process.env.CTA_RANGO_INICIO = 'P3';

  const start = Date.now();
  await assert.rejects(() => limpiarBloque(1), (err) => {
    assert.ok(err instanceof SheetsError, 'debe ser un SheetsError, no un error crudo de google-auth-library');
    assert.match(err.message, /no es JSON válido/);
    assert.ok(err.message.includes(rutaCorrupta) || err.message.includes(path.resolve(rutaCorrupta)));
    return true;
  });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `debe fallar en local casi al instante, tardó ${elapsed}ms (>=500ms sugiere que volvió a caer a un descubrimiento por red)`);

  restoreEnv();
  await rm(dir, { recursive: true, force: true });
});

test('credenciales JSON válidas pero incompletas (falta type/client_email/private_key) -> SheetsError nombrando el campo que falta', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sheets-test-'));

  for (const campoFaltante of ['type', 'client_email', 'private_key']) {
    const credenciales = { type: 'service_account', client_email: 'bot@test.iam.gserviceaccount.com', private_key: 'fake-key' };
    delete credenciales[campoFaltante];
    const ruta = path.join(dir, `sin-${campoFaltante}.json`);
    await writeFile(ruta, JSON.stringify(credenciales), 'utf8');

    process.env.GOOGLE_CREDENTIALS_PATH = ruta;
    process.env.CTA_SHEET_ID = 'fake-sheet-id';
    process.env.CTA_SHEET_TAB = 'Hoja1';
    process.env.CTA_RANGO_INICIO = 'P3';

    await assert.rejects(() => limpiarBloque(1), (err) => {
      assert.ok(err instanceof SheetsError);
      assert.match(err.message, new RegExp(`"${campoFaltante}"`), `debe nombrar el campo "${campoFaltante}"`);
      return true;
    });
  }

  restoreEnv();
  await rm(dir, { recursive: true, force: true });
});

// ============================================================
// Autenticación inyectada: sheetsRequest() (incluido el enriquecido del
// 403) probado de punta a punta con fetch simulado, sin credenciales
// reales ni red — antes no era posible porque getAuthState() siempre
// pasaba por GoogleAuth de verdad.
// ============================================================

test('escribirBloque(): un 403 real se enriquece con el email de la cuenta de servicio', async (t) => {
  process.env.CTA_SHEET_ID = 'fake-sheet-id';
  process.env.CTA_SHEET_TAB = 'Hoja1';
  process.env.CTA_RANGO_INICIO = 'P3';
  __setAuthStateForTests({
    client: { getAccessToken: async () => ({ token: 'fake-token' }) },
    serviceAccountEmail: 'bot@test.iam.gserviceaccount.com',
  });

  t.mock.method(global, 'fetch', async () => ({ ok: false, status: 403, text: async () => 'Forbidden' }));

  await assert.rejects(() => escribirBloque([['Jugador', 'Tank', 'Healer', 'DPS']]), (err) => {
    assert.ok(err instanceof SheetsError);
    assert.equal(err.status, 403);
    assert.match(err.message, /bot@test\.iam\.gserviceaccount\.com/);
    assert.match(err.message, /Compartila/);
    return true;
  });

  __setAuthStateForTests(null);
  restoreEnv();
});

test('escribirBloque(): con auth y fetch simulados, un 200 escribe y limpia sin lanzar', async (t) => {
  process.env.CTA_SHEET_ID = 'fake-sheet-id';
  process.env.CTA_SHEET_TAB = 'Hoja1';
  process.env.CTA_RANGO_INICIO = 'P3';
  __setAuthStateForTests({
    client: { getAccessToken: async () => ({ token: 'fake-token' }) },
    serviceAccountEmail: 'bot@test.iam.gserviceaccount.com',
  });

  const calls = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    calls.push({ url: decodeURIComponent(url.toString()), method: options.method });
    return { ok: true, json: async () => ({}) };
  });

  await assert.doesNotReject(() => escribirBloque([['Jugador', 'Tank', 'Healer', 'DPS']]));
  assert.equal(calls.length, 2, 'una escritura (update) + una limpieza del margen (clear)');
  assert.equal(calls[0].method, 'PUT');
  assert.match(calls[0].url, /P3:S3/); // 1 fila -> P3:S3
  assert.equal(calls[1].method, 'POST');
  assert.match(calls[1].url, /:clear/);

  __setAuthStateForTests(null);
  restoreEnv();
});

// ============================================================
// validarCredencialesSheetsAlArrancar(): nunca lanza, se llama al arrancar
// el bot (no en la primera escritura).
// ============================================================

test('validarCredencialesSheetsAlArrancar(): sin GOOGLE_CREDENTIALS_PATH, no hace nada (no está configurado, no es un error)', async (t) => {
  delete process.env.GOOGLE_CREDENTIALS_PATH;
  const logs = [];
  t.mock.method(console, 'log', (msg) => logs.push(msg));

  await assert.doesNotReject(() => validarCredencialesSheetsAlArrancar());
  assert.equal(logs.length, 1);
  assert.match(logs[0], /"result":"sin-configurar"/);

  restoreEnv();
});

test('validarCredencialesSheetsAlArrancar(): con credenciales inyectadas válidas, registra éxito con el email', async (t) => {
  process.env.GOOGLE_CREDENTIALS_PATH = '/cualquier/cosa.json'; // no se lee: getAuthState() usa el override
  __setAuthStateForTests({
    client: { getAccessToken: async () => ({ token: 'fake-token' }) },
    serviceAccountEmail: 'bot@test.iam.gserviceaccount.com',
  });
  const logs = [];
  t.mock.method(console, 'log', (msg) => logs.push(msg));

  await validarCredencialesSheetsAlArrancar();
  assert.equal(logs.length, 1);
  assert.match(logs[0], /"result":"ok"/);
  assert.match(logs[0], /bot@test\.iam\.gserviceaccount\.com/);

  __setAuthStateForTests(null);
  restoreEnv();
});

test('validarCredencialesSheetsAlArrancar(): con un fichero corrupto, registra el error (nunca lanza) y no tumba el arranque', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sheets-test-'));
  const rutaCorrupta = path.join(dir, 'corrupto.json');
  await writeFile(rutaCorrupta, '{ no es json', 'utf8');
  process.env.GOOGLE_CREDENTIALS_PATH = rutaCorrupta;

  const errors = [];
  t.mock.method(console, 'error', (msg) => errors.push(msg));

  await assert.doesNotReject(() => validarCredencialesSheetsAlArrancar());
  assert.equal(errors.length, 1);
  assert.match(errors[0], /"result":"error"/);
  assert.match(errors[0], /no es JSON válido/);

  restoreEnv();
  await rm(dir, { recursive: true, force: true });
});

// ============================================================
// Override en caliente de hoja/pestaña/rango (/cta hoja, /cta pestana,
// /cta rango): si está puesto en ctaSheetConfig.js, gana sobre el .env; si
// no, cae al .env de siempre.
// ============================================================

test('con un override de hoja/pestaña/rango puesto, la petición usa esos valores en vez de los de .env', async (t) => {
  process.env.CTA_SHEET_ID = 'sheet-del-env';
  process.env.CTA_SHEET_TAB = 'PestañaDelEnv';
  process.env.CTA_RANGO_INICIO = 'P3';
  __setAuthStateForTests({
    client: { getAccessToken: async () => ({ token: 'fake-token' }) },
    serviceAccountEmail: 'bot@test.iam.gserviceaccount.com',
  });

  try {
    await setSheetIdOverride(CTA_SHEET_CONFIG_PATH, 'sheet-override');
    await setSheetTabOverride(CTA_SHEET_CONFIG_PATH, 'PestañaOverride');
    await setRangoInicioOverride(CTA_SHEET_CONFIG_PATH, 'B5');

    const calls = [];
    t.mock.method(global, 'fetch', async (url, options) => {
      calls.push({ url: decodeURIComponent(url.toString()), method: options.method });
      return { ok: true, json: async () => ({}) };
    });

    await escribirBloque([['Jugador', 'Tank', 'Healer', 'DPS']]);

    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/sheet-override\//, 'debe usar el ID de la hoja del override, no el de .env');
    // quoteSheetName() cita el nombre de pestaña porque tiene "ñ" (no es
    // [A-Za-z0-9_]) — comportamiento correcto, ya probado aparte.
    assert.match(calls[0].url, /'PestañaOverride'!B5:E5/, 'debe usar la pestaña y el rango del override, no los de .env');
  } finally {
    // SIEMPRE limpia el override, aunque una aserción falle: si no, el
    // fallo de ESTE test filtraría estado al siguiente (mismo
    // CTA_SHEET_CONFIG_PATH para todo el fichero).
    __setAuthStateForTests(null);
    await setSheetIdOverride(CTA_SHEET_CONFIG_PATH, '');
    await setSheetTabOverride(CTA_SHEET_CONFIG_PATH, '');
    await setRangoInicioOverride(CTA_SHEET_CONFIG_PATH, '');
    restoreEnv();
  }
});

test('sin override (nunca se llamó a /cta hoja/pestana/rango), la petición usa CTA_SHEET_ID/CTA_SHEET_TAB/CTA_RANGO_INICIO de .env', async (t) => {
  process.env.CTA_SHEET_ID = 'sheet-del-env';
  process.env.CTA_SHEET_TAB = 'PestañaDelEnv';
  process.env.CTA_RANGO_INICIO = 'P3';
  __setAuthStateForTests({
    client: { getAccessToken: async () => ({ token: 'fake-token' }) },
    serviceAccountEmail: 'bot@test.iam.gserviceaccount.com',
  });

  try {
    const calls = [];
    t.mock.method(global, 'fetch', async (url, options) => {
      calls.push({ url: decodeURIComponent(url.toString()), method: options.method });
      return { ok: true, json: async () => ({}) };
    });

    await escribirBloque([['Jugador', 'Tank', 'Healer', 'DPS']]);

    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/sheet-del-env\//);
    // "PestañaDelEnv" también tiene "ñ" -> también sale citada.
    assert.match(calls[0].url, /'PestañaDelEnv'!P3:S3/);
  } finally {
    __setAuthStateForTests(null);
    restoreEnv();
  }
});
