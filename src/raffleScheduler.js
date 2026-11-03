import crypto from 'node:crypto';
import { listarGuilds } from './services/guildStore.js';
import { loadRaffles, removeRaffle, normalizeWinners } from './services/rafflesStore.js';
import { buildRaffleResultsEmbed, buildNoParticipantsEmbed, buildRaffleWinnersContent } from './ui/raffleEmbed.js';
import { t, guildLang } from './i18n.js';
import { notifyRaffleFailed } from './logChannel.js';

const RAFFLE_EMOJI = '🎉';
const REACTORS_PAGE_LIMIT = 100;
// Rondas de desempate antes de elegir al azar: sin tope, un empate que se
// repite (improbable, pero posible) sería un bucle sin fin.
const MAX_TIEBREAK_ROUNDS = 10;

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
 * Agrupa por `key` de mayor a menor. El orden dentro de cada grupo es el de
 * entrada (sort estable).
 * @template T
 * @param {T[]} items
 * @param {(item: T) => number} key
 * @returns {T[][]}
 */
function groupByDescending(items, key) {
  const groups = [];
  for (const item of [...items].sort((a, b) => key(b) - key(a))) {
    const last = groups.at(-1);
    if (last && key(last[0]) === key(item)) last.push(item);
    else groups.push([item]);
  }
  return groups;
}

/**
 * Reparte `slots` puestos de arriba abajo entre `entries`, ordenadas por
 * `key`. Un grupo de empatados que cabe entero en lo que queda entra entero;
 * el que NO cabe (como mucho uno: después ya no quedan puestos) se ordena con
 * `breakTie(grupo, puestosQueQuedan)`. Devuelve el orden completo, con los
 * ganadores delante.
 */
function fillSlots(entries, slots, key, breakTie) {
  const ordered = [];
  for (const group of groupByDescending(entries, key)) {
    const remaining = Math.max(0, slots - ordered.length);
    ordered.push(...(remaining > 0 && group.length > remaining ? breakTie(group, remaining) : group));
  }
  return ordered;
}

/**
 * Ordena un grupo empatado que se disputa `slots` puestos: tira de nuevo
 * solo entre ellos y reparte con la misma regla; si vuelven a empatar en el
 * corte, otra ronda solo entre esos, hasta MAX_TIEBREAK_ROUNDS. Pasado el
 * tope, baraja al azar a los que sigan empatados.
 */
function rankTied(entries, slots, round, state, randomInt) {
  if (round > MAX_TIEBREAK_ROUNDS) {
    state.random = true;
    const shuffled = [...entries];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = randomInt(0, i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  state.rounds = round;
  const rolls = new Map(entries.map((entry) => [entry, randomInt(1, 101)]));
  return fillSlots(entries, slots, (entry) => rolls.get(entry), (group, remaining) =>
    rankTied(group, remaining, round + 1, state, randomInt),
  );
}

/**
 * Elige `slots` ganadores distintos entre `results` (cada uno con su tirada):
 * de mayor a menor tirada, y un empate solo se rompe si decide quién entra
 * (más empatados que puestos libres). El roll original se sigue mostrando en
 * el embed; `tiebreak` dice entre quiénes y por cuántos puestos se desempató.
 * Con un solo puesto es lo de siempre: solo un empate en la tirada más alta
 * necesita desempate.
 * @template {{ user: { id: string }, roll: number }} R
 * @param {R[]} results
 * @param {number} slots
 * @param {(min: number, max: number) => number} [randomInt]
 * @returns {{ sorted: R[], tiebreak: { roll: number, participants: R[], slots: number, rounds: number, random: boolean } | null }}
 */
export function pickWinners(results, slots, randomInt = crypto.randomInt) {
  let tiebreak = null;
  const sorted = fillSlots(results, slots, (result) => result.roll, (group, remaining) => {
    const state = { rounds: 0, random: false };
    const ranked = rankTied(group, remaining, 1, state, randomInt);
    tiebreak = { roll: group[0].roll, participants: group, slots: remaining, ...state };
    return ranked;
  });
  return { sorted, tiebreak };
}

/**
 * Resuelve un sorteo: lee las reacciones del mensaje de golpe (nunca
 * acumuladas en memoria), tira los dados, publica el resultado citando el
 * mensaje original, y quita el sorteo de raffles.json.
 *
 * El sorteo sale de raffles.json SIEMPRE, también si publicar falla (canal
 * borrado, permisos retirados, embed rechazado...): si se quedara, cada
 * arranque lo reintentaría y volvería a fallar, para siempre y sin que nadie
 * lo viera. El fallo queda en el log y, si lo hay, en el canal de logs del
 * servidor.
 *
 * `creatorId` se lee de `raffle.creatorId` (persistido en raffles.json) en
 * vez de recibirse aparte: pasarlo como parámetro suelto en cada llamada es
 * justo lo que causó el bug real (un `message` de discord.js acabó en su
 * sitio — y como Message.toString() devuelve message.content, el mensaje
 * final citaba el anuncio entero en vez de mencionar al creador).
 * @param {import('discord.js').Client} client
 * @param {{ id: string, guildId: string, channelId: string, messageId: string, creatorId: string, roleId?: string | null, winners?: number, message?: string | null }} raffle
 * @param {{ delayed?: boolean }} [options]
 */
export async function resolveRaffle(client, raffle, { delayed = false } = {}) {
  clearActiveTimer(raffle.guildId, raffle.id);
  try {
    await publishRaffleResult(client, raffle, { delayed });
  } catch (error) {
    console.error(`[raffle] No se pudo publicar el resultado del sorteo ${raffle.id}; se cierra igualmente:`, error?.stack ?? error);
    await notifyRaffleFailed(client, { guildId: raffle.guildId, channelId: raffle.channelId, creatorId: raffle.creatorId, error });
  } finally {
    await removeRaffle(raffle.guildId, raffle.id);
  }
}

async function publishRaffleResult(client, raffle, { delayed }) {
  // Todo lo que se publica al resolver lo lee el canal: idioma del servidor.
  const lang = await guildLang(raffle.guildId).catch(() => undefined);
  // Si el canal ya no existe, lanza: es un resultado que no se pudo publicar.
  const channel = await client.channels.fetch(raffle.channelId);

  let message;
  try {
    message = await channel.messages.fetch(raffle.messageId);
  } catch (error) {
    console.error(`[raffle] El mensaje ${raffle.messageId} del sorteo ${raffle.id} no se pudo leer (¿borrado?):`, error?.message ?? error);
    await channel.send(t('raffle.messageDeleted', lang)).catch((sendError) => {
      console.error('[raffle] Tampoco se pudo avisar en el canal:', sendError?.stack ?? sendError);
    });
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
    return;
  }

  // Un sorteo anterior a `winners` no lo trae; uno editado a mano puede traer
  // cualquier cosa: siempre se acota a 1-20.
  const slots = normalizeWinners(raffle.winners);
  const { sorted, tiebreak } = pickWinners(rollParticipants(participants), slots);
  const embed = buildRaffleResultsEmbed({
    results: sorted,
    delayed,
    tiebreak,
    totalReactors: reactors.length,
    winners: slots,
    message: raffle.message ?? null,
    lang,
  });
  const content = buildRaffleWinnersContent({
    winnerIds: sorted.slice(0, slots).map((result) => result.user.id),
    creatorId: raffle.creatorId,
    lang,
  });
  await channel.send({ content, embeds: [embed], reply });
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
