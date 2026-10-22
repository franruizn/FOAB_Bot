import { EmbedBuilder } from 'discord.js';
import { t, tn, DEFAULT_LANGUAGE } from '../i18n.js';

// Todo lo de este fichero se publica en el canal: va en el idioma del
// servidor, que el llamador pasa como `lang`.

const RESULT_COLOR = 0x00ff9d;
const TOP_N = 5;
const ROLLS_FIELD_MAX = 1020;

/**
 * Contenido (texto plano, no embed) del anuncio inicial del sorteo.
 *
 * `requiredRoleId` (el rol del parámetro opcional de /raffle) y `roleId` (el
 * raffleRoleId de la config del servidor, que solo pinga sin restringir) son mutuamente
 * excluyentes: si hay rol restrictivo, ese es el público del sorteo y es el
 * único que se menciona — pingear también raffleRoleId sería ruido.
 * @param {{ creatorId: string, endsAtUnixSeconds: number, roleId?: string | null, requiredRoleId?: string | null, lang?: string }} params
 */
export function buildRaffleAnnouncementContent({ creatorId, endsAtUnixSeconds, roleId, requiredRoleId, lang = DEFAULT_LANGUAGE }) {
  const pingRoleId = requiredRoleId ?? roleId;
  const values = { ping: pingRoleId ? `<@&${pingRoleId}> ` : '', creator: creatorId, ends: endsAtUnixSeconds };
  return requiredRoleId
    ? t('raffle.announce.restricted', lang, { ...values, role: requiredRoleId })
    : t('raffle.announce', lang, values);
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
 * @param {Array<{ user: { id: string }, roll: number, tiebreakRoll?: number }>} params.results
 * @param {boolean} [params.delayed] - true si se resolvió con retraso (bot caído al vencer el plazo)
 * @param {{ roll: number, participants: Array<unknown> } | null} [params.tiebreak]
 * @param {number} [params.totalReactors] - cuántos reaccionaron en total, antes de filtrar por rol.
 *   Si es mayor que results.length, hubo descartes y el footer lo explicita.
 * @param {string} [params.lang]
 * @returns {EmbedBuilder}
 */
export function buildRaffleResultsEmbed({ results, delayed = false, tiebreak = null, totalReactors, lang = DEFAULT_LANGUAGE }) {
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
  if (tiebreak) {
    descriptionLines.push(t('raffle.results.tiebreak', lang, { roll: tiebreak.roll, count: tiebreak.participants.length }));
  }
  if (delayed) {
    descriptionLines.push(t('raffle.results.delayed', lang));
  }

  let footerText = t('raffle.footer.rolls', lang);
  if (typeof totalReactors === 'number' && totalReactors > results.length) {
    footerText = t('raffle.footer.valid', lang, { valid: results.length, total: totalReactors });
  } else if (results.length > TOP_N) {
    footerText = t('raffle.footer.count', lang, { count: results.length });
  }

  return new EmbedBuilder()
    .setColor(RESULT_COLOR)
    .setTitle(t('raffle.results.title', lang))
    .setDescription(descriptionLines.join('\n\n'))
    .addFields({ name: t('raffle.results.rollsField', lang), value: truncateRollsText(leaderboardText) })
    .setFooter({ text: footerText });
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
