import { withFileLock, readJsonFile, atomicWriteJson } from './fileStore.js';
import { rutaDe } from './guildStore.js';

// Un raffles.json por servidor (DATA_DIR/guilds/<guildId>/raffles.json), cada
// uno con su propio candado: un sorteo del servidor A nunca espera a que se
// escriba uno del B.

/**
 * @typedef {{id: string, guildId: string, channelId: string, messageId: string, endsAt: number, creatorId: string, roleId?: string | null, winners: number, message?: string | null}} Raffle
 */

export const MIN_WINNERS = 1;
export const MAX_WINNERS = 20;

/**
 * Puestos de un sorteo, siempre dentro de MIN_WINNERS..MAX_WINNERS. Lo que
 * viene de raffles.json no ha pasado por las validaciones del comando (un
 * sorteo de antes de existir la opción no lo trae; uno editado a mano puede
 * traer cualquier cosa), así que se acota al leer.
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeWinners(value) {
  if (!Number.isInteger(value)) return MIN_WINNERS;
  return Math.min(Math.max(value, MIN_WINNERS), MAX_WINNERS);
}

/**
 * Lee los sorteos activos de un servidor. No requiere el candado: el
 * rename() atómico garantiza que siempre se lee o el fichero anterior
 * completo o el nuevo completo, nunca un estado a medias.
 * @param {string} guildId
 * @returns {Promise<Raffle[]>}
 */
export async function loadRaffles(guildId) {
  const raffles = await readJsonFile(rutaDe(guildId, 'raffles.json'), []);
  return raffles.map((raffle) => ({ ...raffle, winners: normalizeWinners(raffle.winners) }));
}

async function mutateRaffles(guildId, mutateFn) {
  const filePath = rutaDe(guildId, 'raffles.json');
  return withFileLock(filePath, async () => {
    const current = await readJsonFile(filePath, []);
    const next = mutateFn(current);
    await atomicWriteJson(filePath, next);
    return next;
  });
}

/**
 * Guarda el sorteo en el raffles.json de SU servidor (raffle.guildId).
 * @param {Raffle} raffle
 */
export async function addRaffle(raffle) {
  return mutateRaffles(raffle.guildId, (raffles) => [...raffles, raffle]);
}

/**
 * @param {string} guildId
 * @param {string} raffleId
 */
export async function removeRaffle(guildId, raffleId) {
  return mutateRaffles(guildId, (raffles) => raffles.filter((r) => r.id !== raffleId));
}
