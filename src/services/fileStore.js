import { readFile, writeFile, rename, mkdir, readdir, unlink, copyFile, access } from 'node:fs/promises';
import path from 'node:path';

// Piezas compartidas por los stores JSON con mutex + escritura atómica +
// backups (squadsStore.js fue el primero en implementar este patrón; este
// módulo evita que ctaComp.js y ctaStore.js lo dupliquen byte a byte).
//
// Cada módulo que use esto sigue teniendo SU PROPIO mutex (createMutex() no
// es un singleton): un fichero JSON = un candado, igual que
// squadsStore.js/rafflesStore.js, que ya son independientes entre sí.

const BACKUP_DIR_NAME = 'backups';
const MAX_BACKUPS = 10;

/**
 * Cadena de mutex por módulo: serializa toda la secuencia
 * leer-modificar-escribir de un fichero, no solo la escritura final.
 * @returns {{ withWriteLock: (task: () => Promise<any>) => Promise<any>, waitForPendingWrites: () => Promise<void> }}
 */
export function createMutex() {
  let writeTail = Promise.resolve();

  function withWriteLock(task) {
    const run = writeTail.then(task, task);
    writeTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function waitForPendingWrites() {
    return writeTail;
  }

  return { withWriteLock, waitForPendingWrites };
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
 * Copia el fichero actual a DATA_DIR/backups/<prefix>-<timestamp>.json antes
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
