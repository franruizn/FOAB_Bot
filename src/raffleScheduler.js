import crypto from 'node:crypto';
import { listarGuilds } from './services/guildStore.js';
import { loadRaffles, removeRaffle } from './services/rafflesStore.js';
import { buildRaffleResultsEmbed, buildNoParticipantsEmbed } from './ui/raffleEmbed.js';
import { t, guildLang } from './i18n.js';

const RAFFLE_EMOJI = '🎉';
const REACTORS_PAGE_LIMIT = 100;

// guildId -> (raffleId -> Timeout). Indexado por servidor: cada uno tiene su
// propio raffles.json y sus timers no se mezclan con los de otro. Solo vive
// en memoria: si el proceso se reinicia, se reconstruye desde los
// raffles.json en initializeRaffles(). No hace falta cancelarlos en el
// shutdown: el estado real vive en los ficheros, no aquí.
/** @type {Map<string, Map<string, NodeJS.Timeout>>} */
const activeTimers = new Map();

// Cancela el temporizador además de olvidarlo: si el sorteo se resuelve por
// otro camino, el temporizador no puede volver a resolverlo al vencer.
// Desde dentro del propio temporizador, clearTimeout no hace nada.
function clearActiveTimer(guildId, raffleId) {
  const timers = activeTimers.get(guildId);
  if (!timers) return;
  clearTimeout(timers.get(raffleId));
  timers.delete(raffleId);
  if (timers.size === 0) activeTimers.delete(guildId);
}

function setActiveTimer(guildId, raffleId, timer) {
  let timers = activeTimers.get(guildId);
  if (!timers) {
    timers = new Map();
    activeTimers.set(guildId, timers);
  }
  timers.set(raffleId, timer);
}

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

/**
 * Filtra `users` a quienes tengan `roleId` en el guild AHORA MISMO (no en el
 * momento en que reaccionaron): alguien pudo perder el rol durante el
 * sorteo, y dejarlo ganar sin tenerlo ya sería un bug visible. Quien se fue
 * del servidor (members.fetch falla) queda descartado sin reventar.
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 * @param {string} roleId
 * @param {import('discord.js').User[]} users
 * @returns {Promise<{ valid: import('discord.js').User[], roleMissing: boolean }>}
 */
async function filterByRole(client, guildId, roleId, users) {
  if (users.length === 0) return { valid: [], roleMissing: false };

  let guild;
  try {
    guild = await client.guilds.fetch(guildId);
  } catch (error) {
    console.error(`[raffle] No se pudo obtener el guild ${guildId} para filtrar por rol:`, error?.message ?? error);
    return { valid: [], roleMissing: true };
  }

  const role = await guild.roles.fetch(roleId).catch(() => null);
  if (!role) return { valid: [], roleMissing: true };

  const valid = [];
  for (const user of users) {
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (member?.roles.cache.has(roleId)) valid.push(user);
  }
  return { valid, roleMissing: false };
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
 *
 * `creatorId` se lee de `raffle.creatorId` (persistido en raffles.json) en
 * vez de recibirse aparte: pasarlo como parámetro suelto en cada llamada es
 * justo lo que causó el bug real (un `message` de discord.js acabó en su
 * sitio — y como Message.toString() devuelve message.content, el mensaje
 * final citaba el anuncio entero en vez de mencionar al creador).
 * @param {import('discord.js').Client} client
 * @param {{ id: string, guildId: string, channelId: string, messageId: string, creatorId: string, roleId?: string | null }} raffle
 * @param {{ delayed?: boolean }} [options]
 */
export async function resolveRaffle(client, raffle, { delayed = false } = {}) {
  clearActiveTimer(raffle.guildId, raffle.id);
  // Todo lo que se publica al resolver lo lee el canal: idioma del servidor.
  const lang = await guildLang(raffle.guildId).catch(() => undefined);

  let channel;
  try {
    channel = await client.channels.fetch(raffle.channelId);
  } catch (error) {
    console.error(`[raffle] No se pudo obtener el canal ${raffle.channelId} del sorteo ${raffle.id}:`, error?.stack ?? error);
    await removeRaffle(raffle.guildId, raffle.id);
    return;
  }

  let message;
  try {
    message = await channel.messages.fetch(raffle.messageId);
  } catch (error) {
    console.error(`[raffle] El mensaje ${raffle.messageId} del sorteo ${raffle.id} no se pudo leer (¿borrado?):`, error?.message ?? error);
    await channel.send(t('raffle.messageDeleted', lang)).catch((sendError) => {
      console.error('[raffle] Tampoco se pudo avisar en el canal:', sendError?.stack ?? sendError);
    });
    await removeRaffle(raffle.guildId, raffle.id);
    return;
  }

  const reaction = message.reactions.cache.get(RAFFLE_EMOJI);
  const reactors = reaction ? await fetchAllReactors(reaction) : [];

  let participants = reactors;
  let roleMissing = false;
  if (raffle.roleId) {
    const filtered = await filterByRole(client, raffle.guildId, raffle.roleId, reactors);
    participants = filtered.valid;
    roleMissing = filtered.roleMissing;
  }

  const reply = { messageReference: raffle.messageId };

  if (participants.length === 0) {
    await channel.send({
      embeds: [buildNoParticipantsEmbed({ delayed, totalReactors: reactors.length, roleMissing, lang })],
      reply,
    });
    await removeRaffle(raffle.guildId, raffle.id);
    return;
  }

  const { sorted, tiebreak } = applyTiebreak(rollParticipants(participants));
  const winner = sorted[0];
  const embed = buildRaffleResultsEmbed({ results: sorted, delayed, tiebreak, totalReactors: reactors.length, lang });
  await channel.send({
    content: t('raffle.winnerLine', lang, { winner: winner.user.id, creator: raffle.creatorId }),
    embeds: [embed],
    reply,
  });

  await removeRaffle(raffle.guildId, raffle.id);

}

/**
 * Programa la resolución de un sorteo para dentro de (endsAt - ahora) ms.
 * @param {import('discord.js').Client} client
 * @param {{ id: string, endsAt: number }} raffle
 */
export function scheduleRaffleResolution(client, raffle) {
  const delayMs = Math.max(0, raffle.endsAt - Date.now());
  const timer = setTimeout(() => {
    resolveRaffle(client, raffle, { delayed: false }).catch((error) => {
      console.error(`[raffle] Error resolviendo el sorteo ${raffle.id}:`, error?.stack ?? error);
    });
  }, delayMs);
  setActiveTimer(raffle.guildId, raffle.id, timer);
}

/**
 * Al arrancar: los sorteos cuyo plazo ya pasó se resuelven de inmediato
 * (marcados como retrasados); los que siguen vivos se reprograman con el
 * tiempo restante. Así un reinicio nunca pierde un sorteo.
 * @param {import('discord.js').Client} client
 */
export async function initializeRaffles(client) {
  for (const guildId of await listarGuilds()) {
    try {
      await initializeGuildRaffles(client, guildId);
    } catch (error) {
      // Un raffles.json roto en un servidor no impide reanudar los demás.
      console.error(`[raffle] Error reanudando los sorteos del servidor ${guildId}:`, error?.stack ?? error);
    }
  }
}

async function initializeGuildRaffles(client, guildId) {
  const stored = await loadRaffles(guildId);
  if (stored.length === 0) return;

  const now = Date.now();
  console.log(`[raffle] Reanudando ${stored.length} sorteo(s) activo(s) del servidor ${guildId}.`);

  // El servidor dueño es el de la carpeta, no lo que diga el JSON: así un
  // sorteo nunca se resuelve ni se borra contra el fichero de otro servidor.
  const raffles = stored.map((raffle) => ({ ...raffle, guildId }));

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

/**
 * Aviso en tiempo real (mejor esfuerzo, no la fuente de verdad): si alguien
 * reacciona a un sorteo con rol y no lo tiene, se le quita la reacción al
 * momento en vez de dejar que se entere al final. Solo actúa si el bot tiene
 * "Gestionar mensajes" en ese canal; sin el permiso no hace nada, porque el
 * filtrado de verdad ocurre en resolveRaffle() al resolver — un evento de
 * reacción que se pierde en un reinicio no debe dejar colarse a nadie, así
 * que esta función nunca es la única barrera.
 * @param {import('discord.js').MessageReaction} reaction
 * @param {import('discord.js').User} user
 */
export async function handleRaffleReactionAdd(reaction, user) {
  if (user.bot) return;

  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
  } catch (error) {
    console.error('[raffle] No se pudo completar una reacción parcial:', error?.message ?? error);
    return;
  }

  if (reaction.emoji.name !== RAFFLE_EMOJI) return;

  const guild = reaction.message.guild;
  if (!guild) return;

  const raffles = await loadRaffles(guild.id);
  const raffle = raffles.find((r) => r.messageId === reaction.message.id);
  if (!raffle?.roleId) return;

  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  const channel = reaction.message.channel;
  if (!me || !channel?.permissionsFor?.(me)?.has('ManageMessages')) return;

  const member = await guild.members.fetch(user.id).catch(() => null);
  if (member?.roles.cache.has(raffle.roleId)) return;

  await reaction.users.remove(user.id).catch((error) => {
    console.error(`[raffle] No se pudo quitar la reacción de ${user.id} en el sorteo ${raffle.id}:`, error?.stack ?? error);
  });
}
