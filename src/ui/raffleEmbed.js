import { EmbedBuilder } from 'discord.js';

const RESULT_COLOR = 0x00ff9d;
const TOP_N = 5;
const ROLLS_FIELD_MAX = 1020;

/**
 * Contenido (texto plano, no embed) del anuncio inicial del sorteo.
 * @param {{ creatorId: string, endsAtUnixSeconds: number, roleId?: string | null }} params
 */
export function buildRaffleAnnouncementContent({ creatorId, endsAtUnixSeconds, roleId }) {
  const rolePing = roleId ? `<@&${roleId}> ` : '';
  return (
    `${rolePing}<@${creatorId}> ha comenzado un sorteo que terminará <t:${endsAtUnixSeconds}:R>.\n\n` +
    `Reacciona con 🎉 para participar.`
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
 * @returns {EmbedBuilder}
 */
export function buildRaffleResultsEmbed({ results, delayed = false, tiebreak = null }) {
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
  if (results.length > TOP_N) {
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
 * Embed para cuando el sorteo termina sin ningún participante.
 * @param {{ delayed?: boolean }} params
 * @returns {EmbedBuilder}
 */
export function buildNoParticipantsEmbed({ delayed = false } = {}) {
  const description = delayed
    ? 'Nadie participó.\n\n⏱️ Este sorteo se resolvió con retraso porque el bot estuvo caído al cumplirse el plazo.'
    : 'Nadie participó.';

  return new EmbedBuilder().setColor(RESULT_COLOR).setTitle('🎲 Resultados del sorteo 🎲').setDescription(description);
}
