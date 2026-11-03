import { EmbedBuilder } from 'discord.js';
import { t, tn, DEFAULT_LANGUAGE } from '../i18n.js';
import { truncateList } from './textTruncate.js';

// Todo lo de este fichero se publica en el canal: va en el idioma del
// servidor, que el llamador pasa como `lang`.

const RESULT_COLOR = 0x00ff9d;
const TOP_N = 5;
const ROLLS_FIELD_MAX = 1020;
const PLACE_MEDALS = ['🥇', '🥈', '🥉'];
// Cuántos empatados se nombran en la línea del desempate antes de resumir.
const TIEBREAK_NAMES_MAX = 25;
const CODE_FENCE = '```';

/**
 * Contenido (texto plano, no embed) del anuncio inicial del sorteo.
 *
 * `requiredRoleId` (el rol del parámetro opcional de /raffle) y `roleId` (el
 * raffleRoleId de la config del servidor, que solo pinga sin restringir) son mutuamente
 * excluyentes: si hay rol restrictivo, ese es el público del sorteo y es el
 * único que se menciona — pingear también raffleRoleId sería ruido.
 *
 * Con más de un ganador, la línea de ganadores va antes de "Reacciona…"; con
 * uno, el texto es el de siempre. El mensaje del sorteo NO va aquí: va en su
 * propio embed (buildRaffleMessageEmbed), para que un markdown sin cerrar no
 * se coma "Reacciona…" ni el "solo miembros de @rol".
 * @param {{ creatorId: string, endsAtUnixSeconds: number, roleId?: string | null, requiredRoleId?: string | null, winners?: number, lang?: string }} params
 */
export function buildRaffleAnnouncementContent({ creatorId, endsAtUnixSeconds, roleId, requiredRoleId, winners = 1, lang = DEFAULT_LANGUAGE }) {
  const pingRoleId = requiredRoleId ?? roleId;
  const extra = winners > 1 ? `\n\n${tn('raffle.results.winners', winners, lang)}` : '';
  const values = { ping: pingRoleId ? `<@&${pingRoleId}> ` : '', creator: creatorId, ends: endsAtUnixSeconds, extra };
  return requiredRoleId
    ? t('raffle.announce.restricted', lang, { ...values, role: requiredRoleId })
    : t('raffle.announce', lang, values);
}

/**
 * El mensaje del sorteo como valor de un field. Cada field se renderiza por
 * separado, así que un markdown roto se queda en su recuadro; aun así, un
 * ``` sin pareja se cierra para que el propio recuadro no se vea roto.
 * @param {string} message
 */
function messageFieldValue(message) {
  const fences = message.split(CODE_FENCE).length - 1;
  return fences % 2 === 1 ? `${message}\n${CODE_FENCE}` : message;
}

function messageFields(message, lang) {
  return message ? [{ name: t('raffle.results.messageField', lang), value: messageFieldValue(message) }] : [];
}

/**
 * Embed que acompaña al anuncio cuando el sorteo tiene mensaje: solo el
 * field del mensaje. Un embed no notifica menciones, y lo escribe quien
 * lanza el comando, no el bot.
 * @param {{ message: string, lang?: string }} params
 * @returns {EmbedBuilder}
 */
export function buildRaffleMessageEmbed({ message, lang = DEFAULT_LANGUAGE }) {
  return new EmbedBuilder().setColor(RESULT_COLOR).addFields(...messageFields(message, lang));
}

/**
 * Red de seguridad para el field ROLLS: con 5 líneas cortas nunca debería
 * activarse, pero si el texto supera el límite, corta por línea completa
 * (nunca a mitad de una mención `<@id>`, que Discord no renderiza bien).
 */
function truncateRollsText(text) {
  if (text.length <= ROLLS_FIELD_MAX) return text;

  const lines = text.split('\n');
  let acc = '';
  for (const line of lines) {
    const candidate = acc ? `${acc}\n${line}` : line;
    if (candidate.length > ROLLS_FIELD_MAX) break;
    acc = candidate;
  }
  return acc;
}

/**
 * Embed de resultados. `results` debe venir ya ordenado por tirada
 * descendente (con el desempate ya aplicado si lo hubo).
 * @param {object} params
 * @param {Array<{ user: { id: string }, roll: number }>} params.results
 * @param {boolean} [params.delayed] - true si se resolvió con retraso (bot caído al vencer el plazo)
 * @param {{ roll: number, participants: Array<{ user: { id: string } }>, slots?: number, rounds?: number, random?: boolean } | null} [params.tiebreak]
 * @param {number} [params.totalReactors] - cuántos reaccionaron en total, antes de filtrar por rol.
 *   Si es mayor que results.length, hubo descartes y el footer lo explicita.
 * @param {number} [params.winners] - puestos del sorteo; con más de 1 el embed cambia de formato
 * @param {string | null} [params.message] - el mensaje del sorteo, para recordar de qué iba
 * @param {string} [params.lang]
 * @returns {EmbedBuilder}
 */
export function buildRaffleResultsEmbed({ results, delayed = false, tiebreak = null, totalReactors, winners = 1, message = null, lang = DEFAULT_LANGUAGE }) {
  if (winners > 1) return buildMultiWinnerEmbed({ results, delayed, tiebreak, totalReactors, slots: winners, message, lang });

  const winner = results[0];
  const top5 = results.slice(0, TOP_N);

  const leaderboardText = top5
    .map((result, index) => {
      const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : '';
      return `${medal} **${index + 1}.** <@${result.user.id}> — \`${result.roll}\``;
    })
    .join('\n');

  const descriptionLines = [t('raffle.results.winner', lang, { user: winner.user.id, roll: winner.roll })];
  if (results.length === 1) {
    descriptionLines.push(t('raffle.results.single', lang));
  }
  if (tiebreak) descriptionLines.push(singleTiebreakText(tiebreak, lang));
  if (delayed) {
    descriptionLines.push(t('raffle.results.delayed', lang));
  }

  return new EmbedBuilder()
    .setColor(RESULT_COLOR)
    .setTitle(t('raffle.results.title', lang))
    .setDescription(descriptionLines.join('\n\n'))
    .addFields(...messageFields(message, lang), { name: t('raffle.results.rollsField', lang), value: truncateRollsText(leaderboardText) })
    .setFooter({ text: footerText(results, totalReactors, lang) });
}

function footerText(results, totalReactors, lang) {
  if (typeof totalReactors === 'number' && totalReactors > results.length) {
    return t('raffle.footer.valid', lang, { valid: results.length, total: totalReactors });
  }
  if (results.length > TOP_N) return t('raffle.footer.count', lang, { count: results.length });
  return t('raffle.footer.rolls', lang);
}

// Con un solo puesto: cuenta cómo se resolvió de verdad. A la segunda
// tirada es el texto de siempre; si hicieron falta más rondas o se acabó
// eligiendo al azar, lo dice.
function singleTiebreakText(tiebreak, lang) {
  const values = { roll: tiebreak.roll, count: tiebreak.participants.length, rounds: tiebreak.rounds };
  if (tiebreak.random) return t('raffle.results.tiebreakSingleRandom', lang, values);
  if (tiebreak.rounds > 1) return t('raffle.results.tiebreakSingleRounds', lang, values);
  return t('raffle.results.tiebreak', lang, values);
}

function rollLine(place, result) {
  return `${place} <@${result.user.id}> — \`${result.roll}\``;
}

/**
 * Líneas de tiradas con TODOS los ganadores y, detrás, los no ganadores que
 * quepan en el field. Corta por línea completa (nunca a mitad de un `<@id>`)
 * y deja sitio para "… y N participantes más".
 */
function rollsFieldText(winnerLines, otherLines, lang) {
  const prefix = winnerLines.join('\n');
  if (otherLines.length === 0) return prefix;
  const budget = ROLLS_FIELD_MAX - prefix.length - 1;
  return `${prefix}\n${truncateList(otherLines, budget, { formatSuffix: (count) => tn('raffle.results.moreParticipants', count, lang) })}`;
}

function formatList(items, lang) {
  return new Intl.ListFormat(lang, { type: 'conjunction' }).format(items);
}

function mentionList(users, lang) {
  const mentions = users.slice(0, TIEBREAK_NAMES_MAX).map((user) => `<@${user.id}>`);
  if (users.length > TIEBREAK_NAMES_MAX) mentions.push(t('common.more', lang, { count: users.length - TIEBREAK_NAMES_MAX }));
  return formatList(mentions, lang);
}

/**
 * Texto (no embed) que acompaña a los resultados: "<@a> ha ganado el sorteo
 * de <@creador>", o la lista de ganadores si hay varios.
 * @param {{ winnerIds: string[], creatorId: string, lang?: string }} params
 */
export function buildRaffleWinnersContent({ winnerIds, creatorId, lang = DEFAULT_LANGUAGE }) {
  if (winnerIds.length === 1) return t('raffle.winnerLine', lang, { winner: winnerIds[0], creator: creatorId });
  return t('raffle.winnersLine', lang, { winners: formatList(winnerIds.map((id) => `<@${id}>`), lang), creator: creatorId });
}

function tiebreakText(tiebreak, lang) {
  const values = { users: mentionList(tiebreak.participants.map((p) => p.user), lang), roll: tiebreak.roll, slots: tiebreak.slots };
  const what = t(tiebreak.slots === 1 ? 'raffle.results.tiebreakLast' : 'raffle.results.tiebreakPlaces', lang, values);
  const how = tiebreak.random
    ? t('raffle.results.tiebreakRandom', lang, { rounds: tiebreak.rounds })
    : tn('raffle.results.tiebreakRounds', tiebreak.rounds, lang);
  return `${what} ${how}`;
}

/**
 * Resultados con varios puestos. `results` viene ordenado con los ganadores
 * delante (ver pickWinners() en raffleScheduler.js); `tiebreak`, si lo hubo,
 * es el empate que decidió quién entraba en los últimos puestos.
 */
function buildMultiWinnerEmbed({ results, delayed, tiebreak, totalReactors, slots, message, lang }) {
  const winnerLines = results.slice(0, slots).map((result, i) => rollLine(PLACE_MEDALS[i] ?? `**${i + 1}.**`, result));
  const otherLines = results.slice(slots).map((result, i) => rollLine(`**${slots + i + 1}.**`, result));

  const descriptionLines = [`${tn('raffle.results.winners', winnerLines.length, lang)}\n${winnerLines.join('\n')}`];
  if (results.length < slots) {
    descriptionLines.push(tn('raffle.results.allWin', results.length, lang, { slots }));
  }
  if (tiebreak) descriptionLines.push(tiebreakText(tiebreak, lang));
  if (delayed) descriptionLines.push(t('raffle.results.delayed', lang));

  return new EmbedBuilder()
    .setColor(RESULT_COLOR)
    .setTitle(t('raffle.results.title', lang))
    .setDescription(descriptionLines.join('\n\n'))
    .addFields(...messageFields(message, lang), { name: t('raffle.results.rollsField', lang), value: rollsFieldText(winnerLines, otherLines, lang) })
    .setFooter({ text: footerText(results, totalReactors, lang) });
}

/**
 * Embed para cuando el sorteo termina sin ningún participante VÁLIDO.
 * Distingue tres casos, para que "no salió nadie" nunca quede ambiguo:
 * - nadie reaccionó en absoluto (totalReactors === 0);
 * - hubo reacciones pero ninguna cumplía el rol requerido (totalReactors > 0);
 * - el rol requerido ya no existe al resolver (roleMissing), caso en el que
 *   no se puede ni comprobar quién cumplía el requisito.
 * @param {{ delayed?: boolean, totalReactors?: number, roleMissing?: boolean, lang?: string }} params
 * @returns {EmbedBuilder}
 */
export function buildNoParticipantsEmbed({ delayed = false, totalReactors = 0, roleMissing = false, lang = DEFAULT_LANGUAGE } = {}) {
  const lines = [];

  if (roleMissing) {
    lines.push(t('raffle.none.roleMissing', lang));
  } else if (totalReactors > 0) {
    lines.push(tn('raffle.none.noValid', totalReactors, lang));
  } else {
    lines.push(t('raffle.none.nobody', lang));
  }

  if (delayed) {
    lines.push(t('raffle.results.delayed', lang));
  }

  return new EmbedBuilder()
    .setColor(RESULT_COLOR)
    .setTitle(t('raffle.results.title', lang))
    .setDescription(lines.join('\n\n'));
}
