import { withFileLock, readJsonFile, atomicWriteJson } from './fileStore.js';
import { rutaDe } from './guildStore.js';

// Un raffles.json por servidor (DATA_DIR/guilds/<guildId>/raffles.json), cada
// uno con su propio candado: un sorteo del servidor A nunca espera a que se
// escriba uno del B.

/**
 * @typedef {{id: string, guildId: string, channelId: string, messageId: string, endsAt: number, creatorId: string, roleId?: string | null}} Raffle
 */

/**
 * Lee los sorteos activos de un servidor. No requiere el candado: el
 * rename() atómico garantiza que siempre se lee o el fichero anterior
 * completo o el nuevo completo, nunca un estado a medias.
 * @param {string} guildId
 * @returns {Promise<Raffle[]>}
 */
export async function loadRaffles(guildId) {
  return readJsonFile(rutaDe(guildId, 'raffles.json'), []);
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
