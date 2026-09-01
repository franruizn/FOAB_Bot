import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

// Guarda el ID de la hoja y el nombre de la pestaña que /cta hoja / /cta
// pestaña cambian en caliente (sin tocar .env ni reiniciar). Si este fichero
// no existe, o un campo está vacío, sheets.js usa CTA_SHEET_ID/CTA_SHEET_TAB
// del .env como valor por defecto — este fichero es un OVERRIDE, no un
// reemplazo obligatorio.

let cache = null; // null hasta el primer load(); luego siempre un objeto (puede tener campos vacíos)

let writeTail = Promise.resolve();

function withWriteLock(task) {
  const run = writeTail.then(task, task);
  writeTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function load(filePath) {
  if (cache) return cache;
  try {
    const raw = await readFile(filePath, 'utf8');
    cache = JSON.parse(raw);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    cache = {};
  }
  return cache;
}

async function persist(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmpPath, filePath);
  cache = data;
}

/**
 * @param {string} filePath
 * @returns {Promise<string | null>}
 */
export async function getSheetIdOverride(filePath) {
  const data = await load(filePath);
  return data.sheetId || null;
}

/**
 * @param {string} filePath
 * @returns {Promise<string | null>}
 */
export async function getSheetTabOverride(filePath) {
  const data = await load(filePath);
  return data.sheetTab || null;
}

/**
 * @param {string} filePath
 * @param {string} sheetId
 * @returns {Promise<void>}
 */
export async function setSheetIdOverride(filePath, sheetId) {
  return withWriteLock(async () => {
    const data = await load(filePath);
    await persist(filePath, { ...data, sheetId });
  });
}

/**
 * @param {string} filePath
 * @param {string} sheetTab
 * @returns {Promise<void>}
 */
export async function setSheetTabOverride(filePath, sheetTab) {
  return withWriteLock(async () => {
    const data = await load(filePath);
    await persist(filePath, { ...data, sheetTab });
  });
}

/**
 * @param {string} filePath
 * @returns {Promise<string | null>}
 */
export async function getRangoInicioOverride(filePath) {
  const data = await load(filePath);
  return data.rangoInicio || null;
}

/**
 * @param {string} filePath
 * @param {string} rangoInicio
 * @returns {Promise<void>}
 */
export async function setRangoInicioOverride(filePath, rangoInicio) {
  return withWriteLock(async () => {
    const data = await load(filePath);
    await persist(filePath, { ...data, rangoInicio });
  });
}

/**
 * SOLO para tests: fuerza a releer el fichero en la próxima llamada, en vez
 * de servir la caché en memoria. Nada de producción llama a esto (la caché
 * dura toda la vida del proceso a propósito: solo cambia vía
 * setSheetIdOverride/setSheetTabOverride, que ya la actualizan).
 */
export function __resetCacheForTests() {
  cache = null;
}
