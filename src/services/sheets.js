import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GoogleAuth } from 'google-auth-library';
import { getSheetIdOverride, getSheetTabOverride, getRangoInicioOverride } from './ctaSheetConfig.js';
import { CTA_SHEET_CONFIG_PATH } from '../dataPaths.js';

// Ver README ("Google Sheets") para el setup completo: cuenta de servicio,
// no OAuth de usuario — el bot corre sin nadie delante y no puede completar
// un flujo de consentimiento interactivo.

const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAYS_MS = [1000, 2000, 4000]; // 1 intento inicial + estos 3 reintentos
let retryDelaysMs = DEFAULT_RETRY_DELAYS_MS;
const CLEAR_MARGIN_ROWS = 50;
const COLUMN_COUNT = 4; // nombre, rol1, rol2, rol3
const SERVICE_ACCOUNT_REQUIRED_FIELDS = ['type', 'client_email', 'private_key'];

/**
 * SOLO para tests: sustituye el backoff real (1s/2s/4s) por otro (p.ej.
 * [0, 0, 0], mismo número de reintentos pero sin esperar) para no pagar
 * segundos reales de espera en la suite. Nada de producción llama a esto.
 * @param {number[] | null} delaysMs
 */
export function __setRetryDelaysForTests(delaysMs) {
  retryDelaysMs = delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
}

export class SheetsError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'SheetsError';
    this.status = status;
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new SheetsError(`Falta la variable de entorno ${name} para usar Google Sheets.`);
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- notación A1: columnas / referencias de celda ---

export function columnLetterToIndex(letters) {
  let index = 0;
  for (const char of letters) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index;
}

export function indexToColumnLetter(index) {
  let letters = '';
  let n = index;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

export function parseCellRef(ref) {
  const match = /^([A-Za-z]+)(\d+)$/.exec(String(ref).trim());
  if (!match) {
    throw new SheetsError(`"${ref}" no es una referencia de celda válida (ej. "P3"). Revisá CTA_RANGO_INICIO.`);
  }
  return { column: match[1].toUpperCase(), row: Number(match[2]) };
}

export function quoteSheetName(name) {
  if (/^[A-Za-z0-9_]+$/.test(name)) return name;
  return `'${name.replace(/'/g, "''")}'`;
}

function getEndColumn(startColumn) {
  return indexToColumnLetter(columnLetterToIndex(startColumn) + COLUMN_COUNT - 1);
}

// La hoja, la pestaña y el rango de inicio se pueden cambiar en caliente con
// /cta hoja / /cta pestana / /cta rango (sin tocar .env ni reiniciar) — ver
// services/ctaSheetConfig.js. Si no se cambiaron nunca, caen al valor de
// .env, igual que siempre.

async function resolveSheetId() {
  const override = await getSheetIdOverride(CTA_SHEET_CONFIG_PATH);
  return override || requireEnv('CTA_SHEET_ID');
}

async function resolveSheetTab() {
  const override = await getSheetTabOverride(CTA_SHEET_CONFIG_PATH);
  return override || requireEnv('CTA_SHEET_TAB');
}

async function resolveRangoInicio() {
  const override = await getRangoInicioOverride(CTA_SHEET_CONFIG_PATH);
  return override || requireEnv('CTA_RANGO_INICIO');
}

async function getBlockStart() {
  return parseCellRef(await resolveRangoInicio());
}

async function buildRange(startColumn, startRow, endColumn, endRow) {
  const tab = await resolveSheetTab();
  return `${quoteSheetName(tab)}!${startColumn}${startRow}:${endColumn}${endRow}`;
}

// --- autenticación: cuenta de servicio, cliente cacheado ---
//
// Las credenciales se leen y validan A MANO (fs + JSON.parse + comprobar
// los campos), y se le pasan a GoogleAuth ya resueltas ({ credentials: ... }),
// nunca { keyFile: ... }. A propósito: pasarle solo la ruta deja que
// GoogleAuth "descubra" las credenciales por su cuenta, y si el fichero
// resulta estar corrupto, ese descubrimiento cae hacia atrás al metadata
// server / ADC — una llamada de red real que tarda ~3s en fallar con
// "Unable to find credentials in current environment", un mensaje FALSO
// (el fichero sí existe, solo que está mal) que además esconde el problema
// real. Validando y pasando las credenciales explícitas, un fichero
// corrupto falla en el momento, en local, sin red, con un mensaje que dice
// justo qué está mal.

async function loadServiceAccountCredentials(credentialsPath) {
  let raw;
  try {
    raw = await readFile(credentialsPath, 'utf8');
  } catch (error) {
    throw new SheetsError(
      `No se pudo leer el fichero de credenciales en "${credentialsPath}": ${error.message}. ` +
        `Revisá GOOGLE_CREDENTIALS_PATH y que el fichero exista (ver README).`,
    );
  }

  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch (error) {
    throw new SheetsError(
      `El fichero de credenciales en "${credentialsPath}" no es JSON válido: ${error.message}. ` +
        `Revisá que sea exactamente el JSON que descargaste de Google Cloud, sin editar.`,
    );
  }

  for (const field of SERVICE_ACCOUNT_REQUIRED_FIELDS) {
    if (!credentials?.[field]) {
      throw new SheetsError(
        `El fichero de credenciales en "${credentialsPath}" no trae "${field}". ` +
          `¿Es realmente la clave JSON de una cuenta de servicio (no un OAuth client, no un fichero editado a mano)?`,
      );
    }
  }

  return credentials;
}

let authStatePromise = null;
let authStateOverride = null;

async function buildAuthState() {
  const credentialsPath = path.resolve(requireEnv('GOOGLE_CREDENTIALS_PATH'));
  const credentials = await loadServiceAccountCredentials(credentialsPath);

  // { credentials } explícitas, NUNCA { keyFile }: ver el comentario de
  // arriba — así GoogleAuth construye el cliente directamente a partir de
  // lo que ya validamos, sin ningún intento de descubrimiento/fallback.
  const auth = new GoogleAuth({ credentials, scopes: [SHEETS_SCOPE] });
  const client = await auth.getClient();

  return { client, serviceAccountEmail: credentials.client_email };
}

function getAuthState() {
  if (authStateOverride) return Promise.resolve(authStateOverride);

  if (!authStatePromise) {
    // Si buildAuthState() falla por CUALQUIER motivo (env var, fichero,
    // credenciales incompletas), no cachear el fallo: sin este catch, un
    // problema transitorio (ej. el volumen con las credenciales monta un
    // instante tarde) queda cacheado para siempre y el bot no se recupera
    // sin reiniciar.
    authStatePromise = buildAuthState().catch((error) => {
      authStatePromise = null;
      throw error;
    });
  }
  return authStatePromise;
}

/**
 * SOLO para tests: sustituye el estado de autenticación (el resultado de
 * GoogleAuth) por uno inyectado, para poder probar sheetsRequest()
 * (incluido el enriquecido del 403) con un `client.getAccessToken()` falso
 * y `fetch` simulado — sin credenciales reales ni red. Pasar `null`
 * restaura el flujo real de GoogleAuth.
 * @param {{ client: { getAccessToken(): Promise<{ token: string }> }, serviceAccountEmail: string } | null} override
 */
export function __setAuthStateForTests(override) {
  authStateOverride = override;
}

/**
 * Valida las credenciales de Google Sheets AL ARRANCAR el bot, no en la
 * primera escritura: así un fichero de credenciales corrupto se descubre
 * en el arranque del contenedor (y queda en los logs de ese arranque), no 3
 * segundos después de que alguien pulse "Apuntarse" en la primera CTA. Esta
 * misma llamada calienta la caché de getAuthState(), así que esa primera
 * escritura real tampoco repite el trabajo.
 *
 * No lanza nunca: si GOOGLE_CREDENTIALS_PATH ni siquiera está configurado,
 * asumimos que este despliegue todavía no usa /cta y no es un error. Si SÍ
 * está configurado pero algo falla (fichero inexistente, JSON inválido,
 * faltan campos, GoogleAuth lo rechaza), se registra como aviso claro.
 * @returns {Promise<void>}
 */
export async function validarCredencialesSheetsAlArrancar() {
  if (!process.env.GOOGLE_CREDENTIALS_PATH) {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'sheets',
        action: 'validarCredenciales',
        result: 'sin-configurar',
      }),
    );
    return;
  }

  try {
    const { serviceAccountEmail } = await getAuthState();
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'sheets',
        action: 'validarCredenciales',
        result: 'ok',
        serviceAccountEmail,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'sheets',
        action: 'validarCredenciales',
        result: 'error',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

// --- log propio: cada escritura registra filas + resultado ---

function logSheetOperation({ action, rows, result, error }) {
  const entry = {
    timestamp: new Date().toISOString(),
    type: 'sheets',
    action,
    rows,
    result,
  };
  if (error) entry.error = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify(entry));
}

// --- capa pura de red: timeout 10s + reintento con backoff en 429/5xx, nunca
// en otros 4xx (incluido 403). No sabe nada de Sheets ni de auth: toma una
// URL/opciones ya armadas. Separada así para poder probarla sin credenciales
// reales de Google (ver scripts/sheets-verify.mjs y la verificación de esta
// sesión, que la ejercita con fetch simulado). ---

export async function fetchWithRetry(url, options) {
  let lastError;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });

      if (response.ok) {
        return await response.json().catch(() => ({}));
      }

      const bodyText = await response.text().catch(() => '');
      const httpError = new SheetsError(`Google Sheets respondió ${response.status}: ${bodyText.slice(0, 300)}`, {
        status: response.status,
      });

      if (response.status === 429 || response.status >= 500) {
        lastError = httpError; // reintentable
      } else {
        throw httpError; // 403 y otros 4xx: no reintenta (403 se enriquece en sheetsRequest)
      }
    } catch (error) {
      if (error instanceof SheetsError) throw error;
      lastError = error; // timeout / error de red: reintentable
    } finally {
      clearTimeout(timeoutId);
    }

    if (attempt < retryDelaysMs.length) {
      await sleep(retryDelaysMs[attempt]);
    }
  }

  throw lastError;
}

// --- petición autenticada a Sheets: arma la URL, pide el token, delega el
// timeout/reintento a fetchWithRetry, y enriquece un 403 con el email de la
// cuenta de servicio (nunca reintenta un 403). ---

async function sheetsRequest(kind, range, body) {
  const spreadsheetId = await resolveSheetId();
  const { client, serviceAccountEmail } = await getAuthState();
  const { token } = await client.getAccessToken();

  const isClear = kind === 'clear';
  const url = new URL(
    `${SHEETS_API_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}${isClear ? ':clear' : ''}`,
  );
  if (!isClear) url.searchParams.set('valueInputOption', 'RAW');

  try {
    return await fetchWithRetry(url, {
      method: isClear ? 'POST' : 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  } catch (error) {
    if (error instanceof SheetsError && error.status === 403) {
      throw new SheetsError(
        `Google Sheets respondió 403 (sin permiso) para la hoja ${spreadsheetId}. Compartila con ` +
          `"${serviceAccountEmail}" (Compartir -> pegar ese email -> permiso de Editor) — sin ese paso ` +
          `la API rechaza incluso con credenciales correctas.`,
        { status: 403 },
      );
    }
    throw error;
  }
}

async function clearRows(startColumn, endColumn, fromRow, toRow) {
  if (fromRow > toRow) return; // nada que limpiar
  await sheetsRequest('clear', await buildRange(startColumn, fromRow, endColumn, toRow));
}

// --- API pública ---

/**
 * Escribe `filas` en el bloque configurado (CTA_RANGO_INICIO, ancho fijo de
 * 4 columnas: nombre, rol1, rol2, rol3) con valueInputOption=RAW — nunca
 * USER_ENTERED: un rol que empiece por "=" o "+" se interpretaría como fórmula.
 * Después limpia el resto del margen gestionado (hasta 50 filas desde el
 * inicio) para que no queden restos de una lista anterior más larga cuando
 * se desapunta gente.
 * @param {string[][]} filas - [[nombre, rol1, rol2, rol3], ...]
 */
export async function escribirBloque(filas) {
  const n = filas.length;
  for (const [index, fila] of filas.entries()) {
    if (fila.length !== COLUMN_COUNT) {
      throw new SheetsError(`La fila ${index + 1} tiene ${fila.length} columnas, se esperaban ${COLUMN_COUNT}.`);
    }
  }

  const { column: startColumn, row: startRow } = await getBlockStart();
  const endColumn = getEndColumn(startColumn);

  try {
    if (n > 0) {
      const writeRange = await buildRange(startColumn, startRow, endColumn, startRow + n - 1);
      await sheetsRequest('update', writeRange, { values: filas });
    }

    await clearRows(startColumn, endColumn, startRow + n, startRow + CLEAR_MARGIN_ROWS - 1);

    logSheetOperation({ action: 'escribirBloque', rows: n, result: 'ok' });
  } catch (error) {
    logSheetOperation({ action: 'escribirBloque', rows: n, result: 'error', error });
    throw error;
  }
}

/**
 * Limpia `numFilas` filas empezando en CTA_RANGO_INICIO (mismo ancho fijo de
 * 4 columnas). Con numFilas=0 limpia todo el margen gestionado (50 filas) —
 * útil para vaciar el bloque por completo.
 * @param {number} numFilas
 */
export async function limpiarBloque(numFilas) {
  if (!Number.isInteger(numFilas) || numFilas < 0) {
    throw new SheetsError(`numFilas debe ser un entero >= 0, recibido: ${numFilas}`);
  }

  const { column: startColumn, row: startRow } = await getBlockStart();
  const endColumn = getEndColumn(startColumn);
  const rows = numFilas === 0 ? CLEAR_MARGIN_ROWS : numFilas;

  try {
    await clearRows(startColumn, endColumn, startRow, startRow + rows - 1);
    logSheetOperation({ action: 'limpiarBloque', rows, result: 'ok' });
  } catch (error) {
    logSheetOperation({ action: 'limpiarBloque', rows, result: 'error', error });
    throw error;
  }
}
