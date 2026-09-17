import { EmbedBuilder, escapeMarkdown } from 'discord.js';

const EMBED_COLOR = 0x00ff9d;
const NEUTRAL_COLOR = 0x99aab5;
const NOT_FOUND_COLOR = 0xf59e0b;

function formatDecimal(value, decimals) {
  return value.toFixed(decimals).replace('.', ',');
}

function footerText(battlesProcessed, battlesRequested) {
  return `Battles processed: ${battlesProcessed}/${battlesRequested}`;
}

/**
 * Embed principal de /score: marcador grande + fields de Kills/Muertes/
 * Jugadores/KDA. Solo para score.empty === false (ver buildEmptySquadScoreEmbed
 * para el caso "ningún miembro presente").
 * @param {object} params
 * @param {import('../services/score.js').computeSquadScore extends (...args: any) => infer R ? Exclude<R, {empty: true}> : never} params.score
 * @param {number} params.battlesProcessed
 * @param {number} params.battlesRequested
 * @param {string} params.originalUrl
 * @param {Date} params.battleDate
 * @returns {EmbedBuilder}
 */
export function buildScoreEmbed({ score, battlesProcessed, battlesRequested, originalUrl, battleDate }) {
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`SCORE — ${score.squadDisplay}`)
    .setURL(originalUrl)
    .setDescription(`# ${score.kills} - ${score.deaths}`)
    .addFields(
      { name: 'Kills', value: `**${score.kills}** · ${formatDecimal(score.killsPorJugador, 1)} por jugador`, inline: true },
      { name: 'Muertes', value: `**${score.deaths}** · ${formatDecimal(score.deathsPorJugador, 1)} por jugador`, inline: true },
      { name: 'Jugadores', value: `**${score.jugadores}**`, inline: true },
      { name: 'KDA', value: `**${formatDecimal(score.kda, 2)}**`, inline: true },
    )
    .setFooter({ text: footerText(battlesProcessed, battlesRequested) })
    .setTimestamp(battleDate);
}

/**
 * Embed neutro para cuando ningún miembro del squad estuvo en la batalla:
 * deliberadamente NO es un marcador "0 - 0" (eso parecería que sí jugaron y
 * no hicieron nada).
 * @param {object} params
 * @param {string} params.squadDisplay
 * @param {number} params.battlesProcessed
 * @param {number} params.battlesRequested
 * @param {string} params.originalUrl
 * @param {Date} params.battleDate
 * @returns {EmbedBuilder}
 */
export function buildEmptySquadScoreEmbed({ squadDisplay, battlesProcessed, battlesRequested, originalUrl, battleDate }) {
  return new EmbedBuilder()
    .setColor(NEUTRAL_COLOR)
    .setTitle(`SCORE — ${squadDisplay}`)
    .setURL(originalUrl)
    .setDescription(`Ningún miembro de **${escapeMarkdown(squadDisplay)}** participó en esta batalla (sin kills, muertes ni asistencias registradas).`)
    .setFooter({ text: footerText(battlesProcessed, battlesRequested) })
    .setTimestamp(battleDate);
}

/**
 * Embed de "squad no encontrado" con sugerencias por distancia de
 * Levenshtein, igual que /attendance para jugadores.
 * @param {{ squadInput: string, suggestions: string[] }} params
 * @returns {EmbedBuilder}
 */
export function buildSquadNotFoundEmbed({ squadInput, suggestions }) {
  const base = `No encontré ningún squad (ni MAIN ZERG) llamado **${escapeMarkdown(squadInput)}**.`;
  const description =
    suggestions.length > 0
      ? `${base}\n\n¿Quisiste decir…?\n${suggestions.map((name) => `• ${escapeMarkdown(name)}`).join('\n')}`
      : base;

  return new EmbedBuilder().setColor(NOT_FOUND_COLOR).setTitle('Squad no encontrado').setDescription(description);
}
