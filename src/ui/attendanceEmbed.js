import { EmbedBuilder, escapeMarkdown } from 'discord.js';

const EMBED_COLOR = 0x00ff9d;
const NOT_FOUND_COLOR = 0xf59e0b;

// Subdominio de albionbb por servidor: americas no lleva subdominio.
const SERVER_SUBDOMAIN = { europe: 'europe.', americas: '', asia: 'east.' };

// Mismas claves que produce services/albionbbApi.js al mapear "roles". Ver
// docs/albionbb-api.md: la identificación de cada rol es por forma de icono,
// no una etiqueta de texto confirmada.
const ROLE_DISPLAY_LABELS = {
  tank: 'Tank',
  support: 'Support',
  healer: 'Healer',
  meleeDps: 'DPS melee',
  rangedDps: 'DPS a distancia',
  mounted: 'Montado',
};

function formatCompactNumber(value) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}b`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatRatio(kills, deaths) {
  if (deaths === 0) return kills > 0 ? '∞' : '0.00';
  return (kills / deaths).toFixed(2);
}

function relativeTimestamp(date) {
  return `<t:${Math.floor(date.getTime() / 1000)}:R>`;
}

function buildRolesFieldValue(roles) {
  const entries = Object.entries(roles ?? {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  return entries.map(([key, count]) => `${ROLE_DISPLAY_LABELS[key] ?? key}: **${count}**`).join(' · ');
}

/**
 * Construye el embed principal de /attendance.
 * @param {object} params
 * @param {object} params.player - entrada devuelta por albionbbApi.getGuildAttendance
 * @param {number} params.rank - posición 1-based en el ranking de attendance del gremio
 * @param {number} params.total - total de jugadores en el ranking
 * @param {'europe'|'americas'|'asia'} params.server
 * @param {string|null} params.squadDisplay - clave de squad en MAYÚSCULA, o null si no tiene
 * @param {{ start: string, end: string }} params.dateRange
 * @returns {EmbedBuilder}
 */
export function buildAttendanceEmbed({ player, rank, total, server, squadDisplay, dateRange }) {
  const titleSuffix = squadDisplay ? ` [${squadDisplay}]` : '';
  const subdomain = SERVER_SUBDOMAIN[server] ?? '';

  const embed = new EmbedBuilder()
    .setTitle(`📊 Attendance — ${escapeMarkdown(player.name)}${titleSuffix}`)
    .setURL(`https://${subdomain}albionbb.com/players/${encodeURIComponent(player.name)}`)
    .setColor(EMBED_COLOR)
    .addFields(
      { name: 'Attendance', value: `**${player.attendance}** batallas\n#${rank} de ${total}`, inline: true },
      {
        name: 'K / D',
        value: `${player.kills} / ${player.deaths}\nRatio: **${formatRatio(player.kills, player.deaths)}**`,
        inline: true,
      },
      { name: 'Avg IP', value: `${Math.round(player.avgIp)}`, inline: true },
      { name: 'Damage', value: formatCompactNumber(player.damage), inline: true },
      { name: 'Healing', value: formatCompactNumber(player.heal), inline: true },
      { name: 'Kill fame', value: formatCompactNumber(player.killFame), inline: true },
      { name: 'Last battle', value: relativeTimestamp(player.lastBattle), inline: true },
    );

  const rolesValue = buildRolesFieldValue(player.roles);
  if (rolesValue) {
    embed.addFields({ name: 'Roles', value: rolesValue, inline: false });
  }

  if (!squadDisplay) {
    embed.addFields({
      name: '⚠️ Sin squad asignado',
      value: 'Este jugador aparece en la attendance del gremio pero no está en ningún squad de squads.json.',
      inline: false,
    });
  }

  embed.setFooter({ text: `Datos de albionbb · rango ${dateRange.start} → ${dateRange.end}` });

  return embed;
}

/**
 * Embed de "jugador no encontrado" con sugerencias por distancia de
 * Levenshtein. No es un error: es un resultado esperado de una búsqueda.
 * @param {{ playerInput: string, suggestions: string[] }} params
 * @returns {EmbedBuilder}
 */
export function buildPlayerNotFoundEmbed({ playerInput, suggestions }) {
  const base = `No encontré a **${escapeMarkdown(playerInput)}** en la attendance del gremio para este rango de fechas.`;
  const description =
    suggestions.length > 0
      ? `${base}\n\n¿Quisiste decir…?\n${suggestions.map((name) => `• ${escapeMarkdown(name)}`).join('\n')}`
      : base;

  return new EmbedBuilder().setColor(NOT_FOUND_COLOR).setTitle('Jugador no encontrado').setDescription(description);
}
