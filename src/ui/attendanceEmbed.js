import { EmbedBuilder, escapeMarkdown } from 'discord.js';
import { t, tn } from '../i18n.js';

const EMBED_COLOR = 0x00ff9d;
const NOT_FOUND_COLOR = 0xf59e0b;

// Subdominio de albionbb por servidor: americas no lleva subdominio.
const SERVER_SUBDOMAIN = { europe: 'europe.', americas: '', asia: 'east.' };

// Mismas claves que produce services/albionbbApi.js al mapear "roles"; el
// texto está en src/i18n.js (attendance.role.*). Ver docs/albionbb-api.md:
// la identificación de cada rol es por forma de icono, no una etiqueta de
// texto confirmada.
const ROLE_KEYS = new Set(['tank', 'support', 'healer', 'meleeDps', 'rangedDps', 'mounted']);

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

function buildRolesFieldValue(roles, lang) {
  const entries = Object.entries(roles ?? {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  return entries
    .map(([key, count]) => `${ROLE_KEYS.has(key) ? t(`attendance.role.${key}`, lang) : key}: **${count}**`)
    .join(' · ');
}

/**
 * Construye el embed principal de /attendance. Es público: va en el idioma
 * del servidor.
 * @param {object} params
 * @param {object} params.player - entrada devuelta por albionbbApi.getGuildAttendance
 * @param {number} params.rank - posición 1-based en el ranking de attendance del gremio
 * @param {number} params.total - total de jugadores en el ranking
 * @param {'europe'|'americas'|'asia'} params.server
 * @param {string|null} params.squadDisplay - clave de squad en MAYÚSCULA, o null si no tiene
 * @param {{ start: string, end: string }} params.dateRange
 * @param {string} params.lang
 * @returns {EmbedBuilder}
 */
export function buildAttendanceEmbed({ player, rank, total, server, squadDisplay, dateRange, lang }) {
  const subdomain = SERVER_SUBDOMAIN[server] ?? '';
  const name = escapeMarkdown(player.name);

  const embed = new EmbedBuilder()
    .setTitle(
      squadDisplay
        ? t('attendance.titleWithSquad', lang, { player: name, squad: squadDisplay })
        : t('attendance.title', lang, { player: name }),
    )
    .setURL(`https://${subdomain}albionbb.com/players/${encodeURIComponent(player.name)}`)
    .setColor(EMBED_COLOR)
    .addFields(
      {
        name: t('attendance.field.attendance', lang),
        value: tn('attendance.value.battles', player.attendance, lang, { rank, total }),
        inline: true,
      },
      {
        name: t('attendance.field.kd', lang),
        value: t('attendance.value.kd', lang, {
          kills: player.kills,
          deaths: player.deaths,
          ratio: formatRatio(player.kills, player.deaths),
        }),
        inline: true,
      },
      { name: t('attendance.field.avgIp', lang), value: `${Math.round(player.avgIp)}`, inline: true },
      { name: t('attendance.field.damage', lang), value: formatCompactNumber(player.damage), inline: true },
      { name: t('attendance.field.healing', lang), value: formatCompactNumber(player.heal), inline: true },
      { name: t('attendance.field.killFame', lang), value: formatCompactNumber(player.killFame), inline: true },
      { name: t('attendance.field.lastBattle', lang), value: relativeTimestamp(player.lastBattle), inline: true },
    );

  const rolesValue = buildRolesFieldValue(player.roles, lang);
  if (rolesValue) {
    embed.addFields({ name: t('attendance.field.roles', lang), value: rolesValue, inline: false });
  }

  if (!squadDisplay) {
    embed.addFields({
      name: t('attendance.noSquad.name', lang),
      value: t('attendance.noSquad.value', lang),
      inline: false,
    });
  }

  embed.setFooter({ text: t('attendance.footer', lang, { start: dateRange.start, end: dateRange.end }) });

  return embed;
}

/**
 * Embed de "jugador no encontrado" con sugerencias por distancia de
 * Levenshtein. No es un error: es un resultado esperado de una búsqueda.
 * @param {{ playerInput: string, suggestions: string[], lang: string }} params
 * @returns {EmbedBuilder}
 */
export function buildPlayerNotFoundEmbed({ playerInput, suggestions, lang }) {
  const player = escapeMarkdown(playerInput);
  const description =
    suggestions.length > 0
      ? t('attendance.notFound.suggestions', lang, {
          player,
          suggestions: suggestions.map((name) => `• ${escapeMarkdown(name)}`).join('\n'),
        })
      : t('attendance.notFound.body', lang, { player });

  return new EmbedBuilder()
    .setColor(NOT_FOUND_COLOR)
    .setTitle(t('attendance.notFound.title', lang))
    .setDescription(description);
}
