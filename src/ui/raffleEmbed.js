import { EmbedBuilder } from 'discord.js';

const RESULT_COLOR = 0x00ff9d;
const TOP_N = 5;
const ROLLS_FIELD_MAX = 1020;

/**
 * Contenido (texto plano, no embed) del anuncio inicial del sorteo.
 *
 * `requiredRoleId` (el rol del parámetro opcional de /sorteo) y `roleId` (el
 * RAFFLE_ROLE_ID de entorno, que solo pinga sin restringir) son mutuamente
 * excluyentes: si hay rol restrictivo, ese es el público del sorteo y es el
 * único que se menciona — pingear también RAFFLE_ROLE_ID sería ruido.
 * @param {{ creatorId: string, endsAtUnixSeconds: number, roleId?: string | null, requiredRoleId?: string | null }} params
 */
export function buildRaffleAnnouncementContent({ creatorId, endsAtUnixSeconds, roleId, requiredRoleId }) {
  const pingRoleId = requiredRoleId ?? roleId;
  const rolePing = pingRoleId ? `<@&${pingRoleId}> ` : '';
  const restriction = requiredRoleId ? ` (solo miembros de <@&${requiredRoleId}>)` : '';
  return (
    `${rolePing}<@${creatorId}> ha comenzado un sorteo que terminará <t:${endsAtUnixSeconds}:R>.\n\n` +
    `Reacciona con 🎉 para participar${restriction}.`
  );
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
 * @returns {EmbedBuilder}
 */
export function buildRaffleResultsEmbed({ results, delayed = false, tiebreak = null, totalReactors }) {
  const winner = results[0];
  const top5 = results.slice(0, TOP_N);

  const leaderboardText = top5
    .map((result, index) => {
      const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : '';
      return `${medal} **${index + 1}.** <@${result.user.id}> — \`${result.roll}\``;
    })
    .join('\n');

  const descriptionLines = [`🥇 **Ganador: <@${winner.user.id}> con una tirada de ${winner.roll}!**`];
  if (results.length === 1) {
    descriptionLines.push('Único participante.');
  }
  if (tiebreak) {
    descriptionLines.push(
      `⚖️ Empate a **${tiebreak.roll}** entre ${tiebreak.participants.length} participantes, resuelto con una segunda tirada.`,
    );
  }
  if (delayed) {
    descriptionLines.push('⏱️ Este sorteo se resolvió con retraso porque el bot estuvo caído al cumplirse el plazo.');
  }

  let footerText = 'Tiradas 1–100';
  if (typeof totalReactors === 'number' && totalReactors > results.length) {
    footerText += ` · ${results.length} de ${totalReactors} participantes válidos`;
  } else if (results.length > TOP_N) {
    footerText += ` · ${results.length} participantes`;
  }

  return new EmbedBuilder()
    .setColor(RESULT_COLOR)
    .setTitle('🎲 Resultados del sorteo 🎲')
    .setDescription(descriptionLines.join('\n\n'))
    .addFields({ name: 'ROLLS', value: truncateRollsText(leaderboardText) })
    .setFooter({ text: footerText });
}

/**
 * Embed para cuando el sorteo termina sin ningún participante VÁLIDO.
 * Distingue tres casos, para que "no salió nadie" nunca quede ambiguo:
 * - nadie reaccionó en absoluto (totalReactors === 0);
 * - hubo reacciones pero ninguna cumplía el rol requerido (totalReactors > 0);
 * - el rol requerido ya no existe al resolver (roleMissing), caso en el que
 *   no se puede ni comprobar quién cumplía el requisito.
 * @param {{ delayed?: boolean, totalReactors?: number, roleMissing?: boolean }} params
 * @returns {EmbedBuilder}
 */
export function buildNoParticipantsEmbed({ delayed = false, totalReactors = 0, roleMissing = false } = {}) {
  const lines = [];

  if (roleMissing) {
    lines.push('El rol requerido para este sorteo ya no existe, así que no se pudo comprobar quién cumplía el requisito. Nadie participó.');
  } else if (totalReactors > 0) {
    lines.push(`${totalReactors} persona(s) reaccionaron, pero ninguna cumplía el rol requerido para participar.`);
  } else {
    lines.push('Nadie participó.');
  }

  if (delayed) {
    lines.push('⏱️ Este sorteo se resolvió con retraso porque el bot estuvo caído al cumplirse el plazo.');
  }

  return new EmbedBuilder().setColor(RESULT_COLOR).setTitle('🎲 Resultados del sorteo 🎲').setDescription(lines.join('\n\n'));
}
