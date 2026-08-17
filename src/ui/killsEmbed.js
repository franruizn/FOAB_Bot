import { EmbedBuilder, escapeMarkdown } from 'discord.js';

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
 * Une `lines` con '\n' recortando al último elemento que quepa entero dentro
 * de `maxLength`, y añade "… +N más" con lo que sobre. Nunca parte un nombre
 * a la mitad.
 */
function truncateList(lines, maxLength) {
  const joined = lines.join('\n');
  if (joined.length <= maxLength) return joined;

  const kept = [];
  let acc = '';
  for (const line of lines) {
    const candidate = acc ? `${acc}\n${line}` : line;
    const remainingAfter = lines.length - (kept.length + 1);
    const suffix = remainingAfter > 0 ? `\n… +${remainingAfter} más` : '';
    if ((candidate + suffix).length > maxLength) break;
    acc = candidate;
    kept.push(line);
  }

  const remaining = lines.length - kept.length;
  if (remaining === 0) return acc;
  return `${acc ? `${acc}\n` : ''}… +${remaining} más`;
}

/**
 * Construye el value de un field de bucket: "**kills** (pct%)\nK-D: ...\n\n__Título__\n<roster>".
 * MAIN ZERG: top 5 killers. Squads: todos los jugadores del bucket (incluidos
 * los de 0 kills), ordenados por kills desc y luego alfabéticamente.
 */
function buildBucketValue(bucket, totalKills) {
  if (bucket.players.length === 0) return EMPTY_FIELD_VALUE;

  const percent = totalKills > 0 ? (bucket.kills / totalKills) * 100 : 0;
  const header = `**${bucket.kills}** (${percent.toFixed(1)}%)\nK-D: **${bucket.kills} - ${bucket.deaths}** Pax: ${bucket.players.length}`;

  const isMain = bucket.key === 'main';
  const rosterTitle = isMain ? 'Top killers' : 'Players';
  const sorted = [...bucket.players].sort(byKillsThenName);
  const roster = sorted.slice(0, MAIN_ZERG_TOP_N);

  const lines = roster.map((p) => formatPlayerLine(p.name, p.kills));
  const prefix = `${header}\n\n__${rosterTitle}__\n`;
  const budget = Math.max(0, FIELD_VALUE_MAX - prefix.length);

  return `${prefix}${truncateList(lines, budget)}`;
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
 * @param {object} params
 * @param {import('../services/aggregate.js').aggregateBattle extends (...args: any) => infer R ? R : never} params.result
 * @param {number} params.battlesProcessed
 * @param {number} params.battlesRequested
 * @param {string} params.guildsDisplay - config.guilds unidos por " / "
 * @param {string} params.originalUrl
 * @param {Date} params.battleDate
 * @returns {EmbedBuilder[]}
 */
export function buildKillsEmbed({ result, battlesProcessed, battlesRequested, guildsDisplay, originalUrl, battleDate }) {
  const { buckets, alliance, totals } = result;

  const description = [
    `Battles processed: ${battlesProcessed}/${battlesRequested}`,
    `Friendly alliance (detected): ${escapeMarkdown(alliance) || EMPTY_FIELD_VALUE}`,
    `Unique counted players (${escapeMarkdown(guildsDisplay)}): ${totals.uniquePlayers}`,
    `Unique counted enemies (not in friendly alliance): ${totals.uniqueEnemies}`,
    '',
    '**TOTAL**',
    `K-D: ${totals.kills} - ${totals.deaths}`,
  ].join('\n');

  const title = '💥 Kills/Deaths per Bombsquads';
  const footerText = `Only players in ${guildsDisplay} are counted. Enemies = players not in the detected friendly alliance.`;

  const fields = buckets.map((bucket) => ({
    name: bucket.display,
    value: buildBucketValue(bucket, totals.kills),
    inline: true,
  }));

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
