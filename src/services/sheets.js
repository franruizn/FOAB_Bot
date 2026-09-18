import { GoogleAuth } from 'google-auth-library';

// Capa fina sobre la API REST de Google Sheets (v4), con auth y fetch
// inyectables para poder testear sin credenciales reales. No sabe nada de
// CTAs: eso vive en ctaSheet.js. Modelo nuevo (una pestaña por evento,
// bloque completo reescrito en cada cambio), no el de un único
// CTA_RANGO_INICIO de la versión anterior.

const SPREADSHEET_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const NOMBRE_PESTANA_MAX = 100; // límite real de Google Sheets para el título de una pestaña
const MAX_INTENTOS_NOMBRE = 25;

export class SheetsError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'SheetsError';
    this.status = status;
  }
}

let authSingleton = null;

function getAuth() {
  if (!authSingleton) {
    const keyFile = process.env.GOOGLE_CREDENTIALS_PATH;
    if (!keyFile) {
      throw new SheetsError('Falta la variable de entorno GOOGLE_CREDENTIALS_PATH.');
    }
    authSingleton = new GoogleAuth({ keyFile, scopes: [SPREADSHEET_SCOPE] });
  }
  return authSingleton;
}

/**
 * Solo para tests: fuerza que la próxima llamada reconstruya el cliente de
 * auth (por si se inyectó GOOGLE_CREDENTIALS_PATH a mitad de proceso).
 */
export function resetAuthParaTests() {
  authSingleton = null;
}

/**
 * El "client_email" del JSON de credenciales: la hoja hay que compartirla
 * con ESTE email como editor, o cualquier llamada falla con 403/404 aunque
 * las credenciales en sí sean válidas — el gotcha más común al configurar
 * esto por primera vez. No hace ninguna llamada de red (solo lee el JSON de
 * credenciales). Ver scripts/verify-sheets.mjs.
 * @returns {Promise<string>}
 * @throws {SheetsError}
 */
export async function obtenerEmailDeServicio() {
  try {
    const { client_email: email } = await getAuth().getCredentials();
    if (!email) {
      throw new SheetsError('El JSON de credenciales no tiene "client_email" (¿es de una cuenta de servicio?).');
    }
    return email;
  } catch (error) {
    if (error instanceof SheetsError) throw error;
    throw new SheetsError(`No se pudieron cargar las credenciales de Google Sheets: ${error.message}`);
  }
}

async function obtenerToken() {
  try {
    const client = await getAuth().getClient();
    const { token } = await client.getAccessToken();
    if (!token) {
      throw new SheetsError('Google no devolvió un token de acceso.');
    }
    return token;
  } catch (error) {
    if (error instanceof SheetsError) throw error;
    throw new SheetsError(`No se pudieron cargar las credenciales de Google Sheets: ${error.message}`);
  }
}

/**
 * @param {string} path - ej. "/{spreadsheetId}:batchUpdate"
 * @param {{ method?: string, body?: object, fetchImpl?: typeof fetch, tokenImpl?: () => Promise<string> }} [options]
 */
async function sheetsRequest(path, { method = 'GET', body, fetchImpl = fetch, tokenImpl = obtenerToken } = {}) {
  const token = await tokenImpl();
  const response = await fetchImpl(`${SHEETS_API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const texto = await response.text().catch(() => '');
    throw new SheetsError(`Google Sheets respondió ${response.status} para "${path}": ${texto.slice(0, 300)}`, {
      status: response.status,
    });
  }

  return response.json();
}

/**
 * Lee solo el título de la hoja (nunca escribe nada): pensada para
 * verificar credenciales/acceso sin tocar el contenido de la spreadsheet.
 * Si esto falla con 401/403, el login con GOOGLE_CREDENTIALS_PATH no
 * sirvió o la cuenta de servicio no tiene la hoja compartida; si falla con
 * 404, CTA_SHEET_ID está mal. Ver scripts/verify-sheets.mjs.
 * @param {string} spreadsheetId
 * @param {object} [reqOptions] - fetchImpl/tokenImpl para tests
 * @returns {Promise<{ titulo: string }>}
 * @throws {SheetsError}
 */
export async function obtenerMetadatosHoja(spreadsheetId, reqOptions = {}) {
  const resultado = await sheetsRequest(`/${spreadsheetId}?fields=properties.title`, reqOptions);
  return { titulo: resultado.properties?.title ?? '' };
}

/**
 * Valida GOOGLE_CREDENTIALS_PATH/CTA_SHEET_ID de un tirón (login + acceso a
 * la hoja, sin escribir nada) — pensada para llamarse UNA vez al arrancar
 * el bot (ver index.js) y para scripts/verify-sheets.mjs, así que nunca
 * lanza: el resultado en sí es la respuesta.
 * @param {object} [reqOptions] - fetchImpl/tokenImpl para tests; solo se
 *   usan en el paso de "acceso" (obtenerMetadatosHoja) — el de "login" lee
 *   el JSON de credenciales directamente, no hace una petición inyectable.
 * @returns {Promise<
 *   | { result: 'sin-configurar' }
 *   | { result: 'ok', email: string, titulo: string }
 *   | { result: 'error', etapa: 'login' | 'acceso', mensaje: string, email?: string, status?: number | null }
 * >}
 */
export async function validarCredenciales(reqOptions = {}) {
  // "sheetsConfigurado()" vive en services/ctaSheet.js (comprueba lo mismo,
  // GOOGLE_CREDENTIALS_PATH + CTA_SHEET_ID), no aquí: este fichero no sabe
  // nada de CTAs, así que se repite la comprobación en vez de importar
  // "hacia arriba" desde el módulo que depende de este.
  if (!process.env.GOOGLE_CREDENTIALS_PATH || !process.env.CTA_SHEET_ID) {
    return { result: 'sin-configurar' };
  }

  let email;
  try {
    email = await obtenerEmailDeServicio();
  } catch (error) {
    return { result: 'error', etapa: 'login', mensaje: error instanceof SheetsError ? error.message : String(error) };
  }

  try {
    const { titulo } = await obtenerMetadatosHoja(process.env.CTA_SHEET_ID, reqOptions);
    return { result: 'ok', email, titulo };
  } catch (error) {
    return {
      result: 'error',
      etapa: 'acceso',
      email,
      status: error instanceof SheetsError ? error.status : null,
      mensaje: error instanceof SheetsError ? error.message : String(error),
    };
  }
}

/**
 * Google no permite ciertos caracteres en el título de una pestaña
 * ([ ] * ? / \ :) ni más de 100 caracteres.
 */
function sanearNombrePestana(nombre) {
  const limpio = String(nombre ?? '')
    .replace(/[[\]*?/\\:]/g, '')
    .trim()
    .slice(0, NOMBRE_PESTANA_MAX);
  return limpio.length > 0 ? limpio : 'CTA';
}

/**
 * Crea una pestaña nueva en la hoja, nombrada como se pida. Si el nombre ya
 * existe (Google responde 400), añade un sufijo "(2)", "(3)"... hasta
 * encontrar uno libre.
 * @param {string} spreadsheetId
 * @param {string} nombreDeseado
 * @param {object} [reqOptions] - fetchImpl/tokenImpl para tests
 * @returns {Promise<string>} el título final de la pestaña creada
 * @throws {SheetsError}
 */
export async function crearPestana(spreadsheetId, nombreDeseado, reqOptions = {}) {
  const base = sanearNombrePestana(nombreDeseado);
  let ultimoError;

  for (let intento = 0; intento <= MAX_INTENTOS_NOMBRE; intento++) {
    const nombre = intento === 0 ? base : `${base} (${intento + 1})`.slice(0, NOMBRE_PESTANA_MAX);
    try {
      const resultado = await sheetsRequest(`/${spreadsheetId}:batchUpdate`, {
        method: 'POST',
        body: { requests: [{ addSheet: { properties: { title: nombre } } }] },
        ...reqOptions,
      });
      return resultado.replies[0].addSheet.properties.title;
    } catch (error) {
      if (error instanceof SheetsError && error.status === 400) {
        ultimoError = error;
        continue; // probablemente el nombre ya existe: prueba el siguiente sufijo
      }
      throw error;
    }
  }

  throw ultimoError;
}

/**
 * Get-or-create para una pestaña de nombre FIJO (a diferencia de
 * crearPestana(), que añade sufijos porque cada CTA quiere un nombre
 * propio): la crea si no existe, y si ya existe (Google responde 400) lo
 * trata como éxito en vez de reintentar con sufijos. Pensado para pestañas
 * únicas como "Maestría", que siempre es la misma y se reescribe entera en
 * cada sincronización.
 * @param {string} spreadsheetId
 * @param {string} nombreExacto
 * @param {object} [reqOptions] - fetchImpl/tokenImpl para tests
 * @throws {SheetsError} si el fallo no es "ya existe"
 */
export async function asegurarPestanaExacta(spreadsheetId, nombreExacto, reqOptions = {}) {
  try {
    await sheetsRequest(`/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: { requests: [{ addSheet: { properties: { title: nombreExacto } } }] },
      ...reqOptions,
    });
  } catch (error) {
    if (error instanceof SheetsError && error.status === 400) return; // ya existía
    throw error;
  }
}

/**
 * Reescribe el bloque completo de una pestaña: limpia un rango generoso y
 * escribe `filas` empezando en A1. Nunca escribe celdas sueltas.
 * @param {string} spreadsheetId
 * @param {string} nombrePestana
 * @param {string[][]} filas
 * @param {object} [reqOptions]
 * @throws {SheetsError}
 */
export async function escribirBloqueCompleto(spreadsheetId, nombrePestana, filas, reqOptions = {}) {
  const pestanaEscapada = nombrePestana.replace(/'/g, "''");

  await sheetsRequest(`/${spreadsheetId}/values/'${pestanaEscapada}'!A1:E1000:clear`, {
    method: 'POST',
    body: {},
    ...reqOptions,
  });

  await sheetsRequest(`/${spreadsheetId}/values/'${pestanaEscapada}'!A1?valueInputOption=RAW`, {
    method: 'PUT',
    body: { values: filas },
    ...reqOptions,
  });
}
