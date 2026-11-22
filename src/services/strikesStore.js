import crypto from 'node:crypto';
import { withFileLock, readJsonFile, backupCurrentFile, atomicWriteJson } from './fileStore.js';
import { rutaDe } from './guildStore.js';

// Un strikes.json por servidor (DATA_DIR/guilds/<guildId>/strikes.json).
//
// Es una lista de EVENTOS, no un contador: tiene que poder responder "¿por qué
// tengo 3?". Quitar un strike nunca lo borra, le pone removedAt/removedBy/
// removedReason. Activos de un usuario = los suyos con removedAt en null.

export const STRIKES_VERSION = 1;
export const MAX_REASON_LENGTH = 200;

/**
 * @typedef {{
 *   id: string, userId: string, userName: string, reason: string,
 *   addedBy: string, addedAt: string,
 *   removedBy: string | null, removedAt: string | null, removedReason: string | null
 * }} Strike
 */

const emptyFile = () => ({ version: STRIKES_VERSION, lastReportAt: null, strikes: [] });

/**
 * Un fichero roto o de una versión futura hace fallar el comando en vez de
 * tratarse como vacío: la siguiente escritura machacaría el historial.
 */
function assertValidFile(data, filePath) {
  const valid =
    data !== null &&
    typeof data === 'object' &&
    data.version === STRIKES_VERSION &&
    (data.lastReportAt === undefined || data.lastReportAt === null || Number.isFinite(Date.parse(data.lastReportAt))) &&
    Array.isArray(data.strikes) &&
    data.strikes.every(
      (s) =>
        typeof s?.id === 'string' &&
        typeof s.userId === 'string' &&
        typeof s.reason === 'string' &&
        typeof s.addedBy === 'string' &&
        Number.isFinite(Date.parse(s.addedAt)),
    );
  if (!valid) throw new Error(`strikes.json inválido o de otra versión: ${filePath}`);
  return data;
}

async function readFileChecked(filePath) {
  return assertValidFile(await readJsonFile(filePath, emptyFile()), filePath);
}

/**
 * Todos los strikes del servidor, retirados incluidos. No requiere el candado:
 * el rename() atómico garantiza leer un fichero completo.
 * @param {string} guildId
 * @returns {Promise<Strike[]>}
 */
export async function loadStrikes(guildId) {
  return (await readFileChecked(rutaDe(guildId, 'strikes.json'))).strikes;
}

/**
 * Los strikes y cuándo se mandó el último informe semanal.
 * @param {string} guildId
 * @returns {Promise<{ strikes: Strike[], lastReportAt: string | null }>}
 */
export async function loadStrikesFile(guildId) {
  const { strikes, lastReportAt } = await readFileChecked(rutaDe(guildId, 'strikes.json'));
  return { strikes, lastReportAt: lastReportAt ?? null };
}

/**
 * Apunta cuándo se mandó el informe. Nunca retrocede.
 * @param {string} guildId
 * @param {string} at - ISO
 */
export async function markReportSent(guildId, at) {
  const filePath = rutaDe(guildId, 'strikes.json');
  await withFileLock(filePath, async () => {
    const data = await readFileChecked(filePath);
    if (data.lastReportAt && Date.parse(data.lastReportAt) >= Date.parse(at)) return;
    data.lastReportAt = at;
    await backupCurrentFile(filePath, 'strikes');
    await atomicWriteJson(filePath, data);
  });
}

/**
 * Cuántos strikes se pusieron y cuántos se quitaron en (sinceMs, untilMs]. El
 * extremo abierto evita contar dos veces lo que cae justo entre dos informes.
 * @param {Strike[]} strikes
 * @param {number} sinceMs
 * @param {number} untilMs
 * @returns {{ added: number, removed: number }}
 */
export function countChanges(strikes, sinceMs, untilMs) {
  const within = (iso) => {
    const ms = Date.parse(iso);
    return ms > sinceMs && ms <= untilMs;
  };
  return {
    added: strikes.filter((s) => within(s.addedAt)).length,
    removed: strikes.filter((s) => !isActive(s) && within(s.removedAt)).length,
  };
}

/**
 * Lee-modifica-escribe bajo el candado del fichero. Si `mutateFn` no cambia
 * nada (devuelve changed: false) no se escribe ni se gasta un backup.
 * @template R
 * @param {string} guildId
 * @param {(strikes: Strike[]) => { changed: boolean, result: R }} mutateFn
 * @returns {Promise<R>}
 */
async function mutateStrikes(guildId, mutateFn) {
  const filePath = rutaDe(guildId, 'strikes.json');
  return withFileLock(filePath, async () => {
    const data = await readFileChecked(filePath);
    const { changed, result } = mutateFn(data.strikes);
    if (changed) {
      await backupCurrentFile(filePath, 'strikes');
      await atomicWriteJson(filePath, data);
    }
    return result;
  });
}

const isActive = (strike) => strike.removedAt === null || strike.removedAt === undefined;
const addedMs = (strike) => Date.parse(strike.addedAt);

/**
 * Strikes activos de un usuario, del más antiguo al más reciente.
 * @param {Strike[]} strikes
 * @param {string} userId
 * @returns {Strike[]}
 */
export function activeStrikes(strikes, userId) {
  return strikes
    .filter((s) => s.userId === userId && isActive(s))
    .map((strike, index) => ({ strike, index }))
    .sort((a, b) => addedMs(a.strike) - addedMs(b.strike) || a.index - b.index)
    .map(({ strike }) => strike);
}

/**
 * Cuántos strikes retirados tiene un usuario.
 * @param {Strike[]} strikes
 * @param {string} userId
 */
export function removedCount(strikes, userId) {
  return strikes.filter((s) => s.userId === userId && !isActive(s)).length;
}

/**
 * El nombre guardado más reciente de un usuario, mirando también sus strikes
 * retirados: cada strike nuevo guarda la foto del nombre de ese momento.
 * @param {Strike[]} strikes
 * @param {string} userId
 * @returns {string | null}
 */
export function lastKnownName(strikes, userId) {
  let latest = null;
  for (const strike of strikes) {
    if (strike.userId !== userId || !strike.userName) continue;
    if (!latest || addedMs(strike) >= addedMs(latest)) latest = strike;
  }
  return latest?.userName ?? null;
}

/**
 * Usuarios con al menos un strike activo, de más a menos (a igualdad, primero
 * el del strike más reciente).
 * @param {Strike[]} strikes
 * @returns {Array<{ userId: string, userName: string | null, count: number, latestAt: string }>}
 */
export function summarizeActive(strikes) {
  const userIds = new Set(strikes.filter(isActive).map((s) => s.userId));
  return [...userIds]
    .map((userId) => {
      const active = activeStrikes(strikes, userId);
      return {
        userId,
        userName: lastKnownName(strikes, userId),
        count: active.length,
        latestAt: active[active.length - 1].addedAt,
      };
    })
    .sort((a, b) => b.count - a.count || Date.parse(b.latestAt) - Date.parse(a.latestAt) || a.userId.localeCompare(b.userId));
}

function newStrikeId(strikes, now) {
  const taken = new Set(strikes.map((s) => s.id));
  let id;
  do {
    id = `stk_${now}_${crypto.randomBytes(2).toString('hex')}`;
  } while (taken.has(id));
  return id;
}

/**
 * @param {string} guildId
 * @param {{ userId: string, userName: string, reason: string, addedBy: string }} params
 * @returns {Promise<{ strike: Strike, activeCount: number }>}
 */
export async function addStrike(guildId, { userId, userName, reason, addedBy }) {
  return mutateStrikes(guildId, (strikes) => {
    const now = Date.now();
    const strike = {
      id: newStrikeId(strikes, now),
      userId,
      userName,
      reason,
      addedBy,
      addedAt: new Date(now).toISOString(),
      removedBy: null,
      removedAt: null,
      removedReason: null,
    };
    strikes.push(strike);
    return { changed: true, result: { strike: { ...strike }, activeCount: activeStrikes(strikes, userId).length } };
  });
}

/**
 * Retira el strike activo MÁS RECIENTE del usuario.
 * @param {string} guildId
 * @param {{ userId: string, removedBy: string, reason?: string | null }} params
 * @returns {Promise<{ strike: Strike | null, activeCount: number }>} strike null si no tenía ninguno
 */
export async function removeLatestStrike(guildId, { userId, removedBy, reason = null }) {
  return mutateStrikes(guildId, (strikes) => {
    const active = activeStrikes(strikes, userId);
    if (active.length === 0) return { changed: false, result: { strike: null, activeCount: 0 } };
    const strike = active[active.length - 1];
    strike.removedBy = removedBy;
    strike.removedAt = new Date().toISOString();
    strike.removedReason = reason;
    return { changed: true, result: { strike: { ...strike }, activeCount: active.length - 1 } };
  });
}

/**
 * Retira de una vez los strikes activos del usuario cuyo id esté en `ids`: los
 * que quien confirma vio en el aviso. Un strike puesto por otro oficial
 * mientras el botón estaba pendiente no se perdona sin haberlo visto.
 * @param {string} guildId
 * @param {{ userId: string, removedBy: string, ids: string[] }} params
 * @returns {Promise<{ cleared: number, activeCount: number }>}
 */
export async function clearStrikes(guildId, { userId, removedBy, ids }) {
  const wanted = new Set(ids);
  return mutateStrikes(guildId, (strikes) => {
    const active = activeStrikes(strikes, userId);
    const targets = active.filter((s) => wanted.has(s.id));
    const removedAt = new Date().toISOString();
    for (const strike of targets) {
      strike.removedBy = removedBy;
      strike.removedAt = removedAt;
      strike.removedReason = null;
    }
    return {
      changed: targets.length > 0,
      result: { cleared: targets.length, activeCount: active.length - targets.length },
    };
  });
}
