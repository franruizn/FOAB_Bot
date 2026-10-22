import { EmbedBuilder, escapeMarkdown } from 'discord.js';
import { truncateList } from './textTruncate.js';
import { t, DEFAULT_LANGUAGE } from '../i18n.js';

const EMBED_COLOR = 0x00ff9d;
const FIELD_VALUE_MAX = 1024;
const EMBED_TOTAL_MAX = 6000;
const MAX_FIELDS_PER_EMBED = 25;
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAIN_ZERG_TOP_N = 5;
const EMPTY_FIELD_VALUE = '—';

function byKillsThenName(a, b) {
  if (b.kills !== a.kills) return b.kills - a.kills;
  return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
}

function formatPlayerLine(name, kills) {
  return `${escapeMarkdown(name)} (${kills})`;
}

/**
 * Construye el value de un field de bucket: "**kills** (pct%)\nK-D: ...\n\n__Título__\n<roster>".
 * MAIN ZERG y squads de gremio: top 5 killers (pueden ser decenas de
 * personas). Squads de jugadores: todos los presentes del bucket (incluidos
 * los de 0 kills, que quedan al final), ordenados por kills desc y luego
 * alfabéticamente. El porcentaje es sobre el total de SU sección.
 */
function buildBucketValue(bucket, totalKills, lang) {
  if (bucket.players.length === 0) return EMPTY_FIELD_VALUE;

  const percent = totalKills > 0 ? (bucket.kills / totalKills) * 100 : 0;
  const header = t('kills.bucket.header', lang, {
    kills: bucket.kills,
    percent: percent.toFixed(1),
    deaths: bucket.deaths,
    pax: bucket.players.length,
  });

  const topOnly = bucket.key === 'main' || bucket.isGuild;
  const rosterTitle = t(topOnly ? 'kills.bucket.topKillers' : 'kills.bucket.players', lang);
  const sorted = [...bucket.players].sort(byKillsThenName);
  const roster = topOnly ? sorted.slice(0, MAIN_ZERG_TOP_N) : sorted;

  const lines = roster.map((p) => formatPlayerLine(p.name, p.kills));
  const prefix = `${header}\n\n__${rosterTitle}__\n`;
  const budget = Math.max(0, FIELD_VALUE_MAX - prefix.length);

  return `${prefix}${truncateList(lines, budget, { formatSuffix: (count) => t('common.more', lang, { count }) })}`;
}

function fieldLength(field) {
  return field.name.length + field.value.length;
}

/**
 * Reparte `fields` en chunks respetando MAX_FIELDS_PER_EMBED y un presupuesto
 * de caracteres por chunk (el primero, más ajustado porque comparte el
 * embed con título/descripción/footer; el resto con el máximo completo).
 */
function packFieldsIntoChunks(fields, firstChunkBudget) {
  const chunks = [];
  let current = [];
  let currentLength = 0;
  let budget = firstChunkBudget;

  for (const field of fields) {
    const len = fieldLength(field);
    const wouldOverflow = current.length >= MAX_FIELDS_PER_EMBED || currentLength + len > budget;

    if (current.length > 0 && wouldOverflow) {
      chunks.push(current);
      current = [];
      currentLength = 0;
      budget = EMBED_TOTAL_MAX;
    }

    current.push(field);
    currentLength += len;
  }

  if (current.length > 0 || chunks.length === 0) {
    chunks.push(current);
  }

  return chunks;
}

/**
 * Construye el/los embed(s) de /getkills a partir del resultado de
 * aggregateBattle. Devuelve un array de EmbedBuilder: normalmente 1, pero se
 * divide en varios si el contenido supera los límites de Discord (25 fields /
 * 6000 caracteres por embed), hasta un máximo de 10 embeds por mensaje.
 *
 * Los nombres de jugadores, de squads y de gremios no se traducen; MAIN
 * ZERG, TOTAL, K-D y Pax son jerga del gremio y se quedan igual.
 *
 * @param {object} params
 * @param {import('../services/aggregate.js').aggregateBattle extends (...args: any) => infer R ? R : never} params.result
 * @param {number} params.battlesProcessed
 * @param {number} params.battlesRequested
 * @param {string} params.mainGuildDisplay - gremio principal del servidor (albionGuild), con su casing
 * @param {boolean} [params.hasSquads] - false si el servidor no tiene ningún squad: se avisa en vez de
 *   dejar un MAIN ZERG a solas que parece un fallo
 * @param {string} params.originalUrl
 * @param {Date} params.battleDate
 * @param {string} [params.lang] - idioma del servidor: el embed es público
 * @returns {EmbedBuilder[]}
 */
export function buildKillsEmbed({
  result,
  battlesProcessed,
  battlesRequested,
  mainGuildDisplay,
  hasSquads = true,
  originalUrl,
  battleDate,
  lang = DEFAULT_LANGUAGE,
}) {
  const { buckets, alliance, totals } = result;
  const guildBuckets = result.guildBuckets ?? [];
  const followedTotals = result.followedTotals ?? { kills: 0, deaths: 0, uniquePlayers: 0 };
  const combinedTotals = result.combinedTotals ?? totals;
  const hasFollowed = guildBuckets.length > 0;
  const mainName = escapeMarkdown(mainGuildDisplay);

  // Las dos secciones nunca se suman en silencio: el TOTAL es solo del gremio
  // principal, y el conjunto va en una línea aparte etiquetada como tal.
  const description = [
    ...(hasSquads ? [] : [t('kills.noSquads', lang), '']),
    t('kills.battlesProcessed', lang, { processed: battlesProcessed, requested: battlesRequested }),
    t('kills.alliance', lang, { alliance: escapeMarkdown(alliance) || EMPTY_FIELD_VALUE }),
    t('kills.uniqueMain', lang, { guild: mainName, count: totals.uniquePlayers }),
    ...(hasFollowed ? [t('kills.uniqueFollowed', lang, { count: followedTotals.uniquePlayers })] : []),
    t(hasFollowed ? 'kills.uniqueEnemiesFollowed' : 'kills.uniqueEnemies', lang, { count: totals.uniqueEnemies }),
    '',
    t('kills.total', lang, { guild: mainName }),
    t('kills.kd', lang, { kills: totals.kills, deaths: totals.deaths }),
    ...(hasFollowed
      ? [
          '',
          t('kills.followedHeader', lang),
          t('kills.kd', lang, { kills: followedTotals.kills, deaths: followedTotals.deaths }),
          '',
          t('kills.combinedHeader', lang, { guild: mainName }),
          t('kills.combinedLine', lang, {
            kills: combinedTotals.kills,
            deaths: combinedTotals.deaths,
            pax: combinedTotals.uniquePlayers,
          }),
        ]
      : []),
  ].join('\n');

  const title = t('kills.title', lang);
  const footerText = t(hasFollowed ? 'kills.footer.followed' : 'kills.footer.main', lang, { guild: mainGuildDisplay });

  const fields = buckets.map((bucket) => ({
    name: bucket.display,
    value: buildBucketValue(bucket, totals.kills, lang),
    inline: true,
  }));

  if (hasFollowed) {
    fields.push({
      name: t('kills.followedField.name', lang),
      value: t('kills.followedField.value', lang, {
        guild: mainName,
        kills: followedTotals.kills,
        deaths: followedTotals.deaths,
        pax: followedTotals.uniquePlayers,
      }),
      inline: false,
    });
    for (const bucket of guildBuckets) {
      fields.push({ name: `🛡️ ${bucket.display}`, value: buildBucketValue(bucket, followedTotals.kills, lang), inline: true });
    }
  }

  const baseLength = title.length + description.length + footerText.length;
  const firstChunkBudget = Math.max(0, EMBED_TOTAL_MAX - baseLength);
  const chunks = packFieldsIntoChunks(fields, firstChunkBudget).slice(0, MAX_EMBEDS_PER_MESSAGE);

  return chunks.map((chunkFields, index) => {
    const embed = new EmbedBuilder().setColor(EMBED_COLOR);

    if (index === 0) {
      embed.setTitle(title).setURL(originalUrl).setDescription(description).setFooter({ text: footerText });
      if (battleDate) embed.setTimestamp(battleDate);
    }

    if (chunkFields.length > 0) embed.addFields(chunkFields);
    return embed;
  });
}
