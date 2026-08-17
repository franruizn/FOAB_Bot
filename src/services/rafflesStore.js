import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

// Mutex propio (independiente del de squadsStore.js: son ficheros distintos,
// no tiene sentido serializarlos entre sí) con el mismo patrón: cadena de
// promesas + tmp/rename para que un fs.rename() nunca deje el fichero a medias.
let writeTail = Promise.resolve();

function withWriteLock(task) {
  const run = writeTail.then(task, task);
  writeTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Igual que squadsStore.waitForPendingWrites(): se resuelve cuando termina la
 * última escritura de raffles.json encolada en este momento.
 * @returns {Promise<void>}
 */
export function waitForPendingRaffleWrites() {
  return writeTail;
}

async function readRafflesFile(filePath) {
  try {
    const content = await readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function atomicWrite(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmpPath, filePath);
}

/**
 * Lee los sorteos activos. No requiere el mutex: el rename() atómico
 * garantiza que siempre se lee o el fichero anterior completo o el nuevo
 * completo, nunca un estado a medias.
 * @param {string} filePath
 * @returns {Promise<Array<{id: string, guildId: string, channelId: string, messageId: string, endsAt: number, creatorId: string}>>}
 */
export async function loadRaffles(filePath) {
  return readRafflesFile(filePath);
}

async function mutateRaffles(filePath, mutateFn) {
  return withWriteLock(async () => {
    const current = await readRafflesFile(filePath);
    const next = mutateFn(current);
    await atomicWrite(filePath, next);
    return next;
  });
}

/**
 * @param {string} filePath
 * @param {{id: string, guildId: string, channelId: string, messageId: string, endsAt: number, creatorId: string}} raffle
 */
export async function addRaffle(filePath, raffle) {
  return mutateRaffles(filePath, (raffles) => [...raffles, raffle]);
}

/**
 * @param {string} filePath
 * @param {string} raffleId
 */
export async function removeRaffle(filePath, raffleId) {
  return mutateRaffles(filePath, (raffles) => raffles.filter((r) => r.id !== raffleId));
}
