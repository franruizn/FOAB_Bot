import crypto from 'node:crypto';
import { RAFFLES_PATH } from './dataPaths.js';
import { loadRaffles, removeRaffle } from './services/rafflesStore.js';
import { buildRaffleResultsEmbed, buildNoParticipantsEmbed } from './ui/raffleEmbed.js';

const RAFFLE_EMOJI = '🎉';
const REACTORS_PAGE_LIMIT = 100;

// raffleId -> Timeout. Solo vive en memoria: si el proceso se reinicia, se
// reconstruye desde raffles.json en initializeRaffles(). No hace falta
// cancelarlos en el shutdown: el estado real vive en el fichero, no aquí.
const activeTimers = new Map();

/**
 * Trae TODOS los usuarios que reaccionaron con 🎉, paginando de a 100 (el
 * máximo que devuelve reaction.users.fetch()), y filtra bots (incluido el
 * propio bot, que reacciona él mismo en el paso 3 del flujo).
 * @param {import('discord.js').MessageReaction} reaction
 * @returns {Promise<import('discord.js').User[]>}
 */
async function fetchAllReactors(reaction) {
  const collected = new Map();
  let after;

  for (;;) {
    const batch = await reaction.users.fetch({ limit: REACTORS_PAGE_LIMIT, after });
    for (const [id, user] of batch) collected.set(id, user);
    if (batch.size < REACTORS_PAGE_LIMIT) break;
    after = [...batch.keys()][batch.size - 1];
  }

  return [...collected.values()].filter((user) => !user.bot);
}

function rollParticipants(users) {
  return users.map((user) => ({ user, roll: crypto.randomInt(1, 101) }));
}

/**
 * Ordena por tirada descendente. Si hay empate en la tirada MÁS ALTA, tira
 * una segunda vez solo entre los empatados y usa esa segunda tirada para
 * desempatar el orden (el roll original se sigue mostrando en el embed, así
 * el empate queda visible; la nota de qué pasó se añade aparte).
 * @param {Array<{ user: unknown, roll: number }>} results
 * @returns {{ sorted: Array<{ user: unknown, roll: number, tiebreakRoll?: number }>, tiebreak: { roll: number, participants: unknown[] } | null }}
 */
function applyTiebreak(results) {
  const maxRoll = Math.max(...results.map((r) => r.roll));
  const tied = results.filter((r) => r.roll === maxRoll);

  let tiebreak = null;
  if (tied.length > 1) {
    for (const result of tied) {
      result.tiebreakRoll = crypto.randomInt(1, 101);
    }
    tiebreak = { roll: maxRoll, participants: tied };
  }

  const sorted = [...results].sort((a, b) => {
    if (b.roll !== a.roll) return b.roll - a.roll;
    return (b.tiebreakRoll ?? -1) - (a.tiebreakRoll ?? -1);
  });

  return { sorted, tiebreak };
}

/**
 * Resuelve un sorteo: lee las reacciones del mensaje de golpe (nunca
 * acumuladas en memoria), tira los dados, publica el resultado citando el
 * mensaje original, y quita el sorteo de raffles.json.
 * @param {import('discord.js').Client} client
 * @param {{ id: string, channelId: string, messageId: string }} raffle
 * @param {{ delayed?: boolean }} [options]
 */
export async function resolveRaffle(client, raffle, creatorId, { delayed = false } = {}) {
  activeTimers.delete(raffle.id);

  let channel;
  try {
    channel = await client.channels.fetch(raffle.channelId);
  } catch (error) {
    console.error(`[raffle] No se pudo obtener el canal ${raffle.channelId} del sorteo ${raffle.id}:`, error?.stack ?? error);
    await removeRaffle(RAFFLES_PATH, raffle.id);
    return;
  }

  let message;
  try {
    message = await channel.messages.fetch(raffle.messageId);
  } catch (error) {
    console.error(`[raffle] El mensaje ${raffle.messageId} del sorteo ${raffle.id} no se pudo leer (¿borrado?):`, error?.message ?? error);
    await channel.send('⚠️ No se pudo resolver un sorteo: el mensaje original fue borrado.').catch((sendError) => {
      console.error('[raffle] Tampoco se pudo avisar en el canal:', sendError?.stack ?? sendError);
    });
    await removeRaffle(RAFFLES_PATH, raffle.id);
    return;
  }

  const reaction = message.reactions.cache.get(RAFFLE_EMOJI);
  const participants = reaction ? await fetchAllReactors(reaction) : [];

  const reply = { messageReference: raffle.messageId };

  if (participants.length === 0) {
    await channel.send({ embeds: [buildNoParticipantsEmbed({ delayed })], reply });
    await removeRaffle(RAFFLES_PATH, raffle.id);
    return;
  }

  const { sorted, tiebreak } = applyTiebreak(rollParticipants(participants));
  const winner = sorted[0];
  const embed = buildRaffleResultsEmbed({ results: sorted, delayed, tiebreak });
  await channel.send({ content: `<@${winner.user.id}> ha ganado el sorteo de <@${creatorId}>`, embeds: [embed], reply });

  await removeRaffle(RAFFLES_PATH, raffle.id);

}

/**
 * Programa la resolución de un sorteo para dentro de (endsAt - ahora) ms.
 * @param {import('discord.js').Client} client
 * @param {{ id: string, endsAt: number }} raffle
 */
export function scheduleRaffleResolution(client, raffle, creatorId) {
  const delayMs = Math.max(0, raffle.endsAt - Date.now());
  const timer = setTimeout(() => {
    resolveRaffle(client, raffle, creatorId, { delayed: false }).catch((error) => {
      console.error(`[raffle] Error resolviendo el sorteo ${raffle.id}:`, error?.stack ?? error);
    });
  }, delayMs);
  activeTimers.set(raffle.id, timer);
}

/**
 * Al arrancar: los sorteos cuyo plazo ya pasó se resuelven de inmediato
 * (marcados como retrasados); los que siguen vivos se reprograman con el
 * tiempo restante. Así un reinicio nunca pierde un sorteo.
 * @param {import('discord.js').Client} client
 */
export async function initializeRaffles(client) {
  const raffles = await loadRaffles(RAFFLES_PATH);
  if (raffles.length === 0) return;

  const now = Date.now();
  console.log(`[raffle] Reanudando ${raffles.length} sorteo(s) activo(s) desde ${RAFFLES_PATH}.`);

  for (const raffle of raffles) {
    if (raffle.endsAt <= now) {
      await resolveRaffle(client, raffle, { delayed: true }).catch((error) => {
        console.error(`[raffle] Error resolviendo el sorteo atrasado ${raffle.id}:`, error?.stack ?? error);
      });
    } else {
      scheduleRaffleResolution(client, raffle);
    }
  }
}
