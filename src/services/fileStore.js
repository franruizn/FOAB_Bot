import { readFile, writeFile, rename, mkdir, readdir, unlink, copyFile, access } from 'node:fs/promises';
import path from 'node:path';

// Piezas compartidas por los stores JSON con mutex + escritura atómica +
// backups: squadsStore.js, rafflesStore.js, guildStore.js y massDm.js.
//
// Un fichero JSON = un candado, indexado por su ruta absoluta. Con varios
// servidores, un candado por store serializaría la escritura del servidor A
// con la del B sin motivo; uno por fichero solo serializa lo que de verdad
// compite por el mismo fichero.

const BACKUP_DIR_NAME = 'backups';
const MAX_BACKUPS = 10;

/** @type {Map<string, Promise<void>>} ruta absoluta -> cola de ese fichero */
const fileTails = new Map();

/**
 * Serializa toda la secuencia leer-modificar-escribir de `filePath`, no solo
 * la escritura final. Dos ficheros distintos nunca se esperan entre sí.
 * @template T
 * @param {string} filePath
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export function withFileLock(filePath, task) {
  const key = path.resolve(filePath);
  const previous = fileTails.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  fileTails.set(key, tail);
  // Sin esto el Map crecería con cada fichero tocado alguna vez: se borra la
  // entrada en cuanto su cola se vacía (si nadie encoló detrás mientras tanto).
  tail.then(() => {
    if (fileTails.get(key) === tail) fileTails.delete(key);
  });
  return run;
}

/**
 * Se resuelve cuando terminan todas las escrituras encoladas en este momento,
 * de cualquier fichero. Pensado para el shutdown por SIGTERM: esperar esto
 * antes de salir evita cortar un fs.rename() a mitad. No espera escrituras
 * que se encolen DESPUÉS de llamarlo.
 * @returns {Promise<void>}
 */
export async function waitForAllFileWrites() {
  await Promise.all([...fileTails.values()]);
}

/**
 * Lee y parsea un JSON. Si el fichero no existe todavía (primer arranque,
 * nada se ha guardado nunca), devuelve una copia de `defaultValue` en vez de
 * fallar.
 * @param {string} filePath
 * @param {object} defaultValue
 */
export async function readJsonFile(filePath, defaultValue) {
  try {
    const content = await readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(defaultValue);
    throw error;
  }
}

/**
 * Copia el fichero actual a <su carpeta>/backups/<prefix>-<timestamp>.json antes
 * de sobrescribirlo, y conserva solo las últimas MAX_BACKUPS copias con ese
 * prefijo (no toca backups de otros stores que compartan el directorio). No
 * hace nada si el fichero todavía no existe (nada que respaldar).
 * @param {string} filePath
 * @param {string} backupPrefix
 */
export async function backupCurrentFile(filePath, backupPrefix) {
  try {
    await access(filePath);
  } catch {
    return;
  }

  const backupDir = path.join(path.dirname(filePath), BACKUP_DIR_NAME);
  await mkdir(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  await copyFile(filePath, path.join(backupDir, `${backupPrefix}-${timestamp}.json`));

  const entries = (await readdir(backupDir))
    .filter((name) => name.startsWith(`${backupPrefix}-`) && name.endsWith('.json'))
    .sort(); // timestamps ISO -> orden lexicográfico == orden cronológico

  const excess = entries.length - MAX_BACKUPS;
  for (let i = 0; i < excess; i++) {
    await unlink(path.join(backupDir, entries[i]));
  }
}

/**
 * Escribe `data` en `filePath` de forma atómica (tmp + rename): un lector
 * concurrente nunca ve un fichero a medio escribir.
 * @param {string} filePath
 * @param {object} data
 */
export async function atomicWriteJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmpPath, filePath);
}
