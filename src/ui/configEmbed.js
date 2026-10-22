import { EmbedBuilder } from 'discord.js';
import { CONFIG_FIELDS } from '../services/configFields.js';

const OK_COLOR = 0x57f287;
const PENDING_COLOR = 0xfee75c;
const CHANGE_COLOR = 0x5865f2;

/**
 * Estado de un campo: 'set', 'missing' (null) o 'broken' (apunta a un rol o
 * canal que ya no existe en el servidor). Sin `guild` en caché no se puede
 * saber si sigue existiendo y se da por bueno.
 * @param {import('../services/configFields.js').ConfigField} field
 * @param {string | null} value
 * @param {import('discord.js').Guild | null} [guild]
 * @returns {'set' | 'missing' | 'broken'}
 */
export function fieldStatus(field, value, guild) {
  if (!value) return 'missing';
  if (field.kind === 'role' && guild?.roles?.cache && !guild.roles.cache.has(value)) return 'broken';
  if (field.kind === 'channel' && guild?.channels?.cache && !guild.channels.cache.has(value)) return 'broken';
  return 'set';
}

/**
 * Un valor tal cual, para mostrar: mención de rol o de canal, o el texto.
 * @param {import('../services/configFields.js').ConfigField} field
 * @param {string | null} value
 */
export function formatValue(field, value) {
  if (!value) return 'sin configurar';
  if (field.kind === 'role') return `<@&${value}>`;
  if (field.kind === 'channel') return `<#${value}>`;
  return `\`${value}\``;
}

function formatFieldForView(field, value, status) {
  if (status === 'missing') return field.required ? '❌ **sin configurar**' : '➖ sin configurar (opcional)';
  if (status === 'broken') {
    const what = field.kind === 'role' ? 'El rol' : 'El canal';
    return `⚠️ ${what} configurado (\`${value}\`) ya no existe`;
  }
  return `✅ ${formatValue(field, value)}`;
}

/**
 * Lo que falta (o está roto) y qué deja de funcionar por ello, una línea por
 * campo. Vacío si no falta nada.
 * @param {object} config
 * @param {import('discord.js').Guild | null} [guild]
 * @returns {string[]}
 */
export function describeGaps(config, guild) {
  const lines = [];
  for (const field of CONFIG_FIELDS) {
    if (fieldStatus(field, config[field.key], guild) === 'set') continue;
    const fix = `\`/config ${field.sub}\``;
    if (field.blocks.length > 0) {
      lines.push(`🚫 ${field.blocks.join(', ')}: falta **${field.label.toLowerCase()}** → ${fix}`);
    } else if (field.impact) {
      lines.push(`${field.required ? '⚠️' : 'ℹ️'} ${field.impact} → ${fix}`);
    }
  }
  return lines;
}

/**
 * /config ver: cada campo con su valor (o marcado si falta) y, al final, qué
 * comandos no funcionan todavía por lo que falta.
 * @param {{ config: object, guild?: import('discord.js').Guild | null }} params
 */
export function buildConfigViewEmbed({ config, guild = null }) {
  const gaps = describeGaps(config, guild);
  const blocking = CONFIG_FIELDS.some(
    (field) => field.required && fieldStatus(field, config[field.key], guild) !== 'set',
  );

  const embed = new EmbedBuilder()
    .setColor(blocking ? PENDING_COLOR : OK_COLOR)
    .setTitle('⚙️ Configuración de este servidor')
    .addFields(
      CONFIG_FIELDS.map((field) => ({
        name: `${field.label} · /config ${field.sub}`,
        value: formatFieldForView(field, config[field.key], fieldStatus(field, config[field.key], guild)),
        inline: false,
      })),
    )
    .addFields({
      name: gaps.length > 0 ? 'Qué no funciona todavía' : 'Estado',
      value: gaps.length > 0 ? gaps.join('\n').slice(0, 1024) : '✅ Todo configurado: todos los comandos funcionan.',
      inline: false,
    });

  if (config.configuradoEn) {
    const when = `<t:${Math.floor(new Date(config.configuradoEn).getTime() / 1000)}:R>`;
    const who = config.configuradoPor ? ` por <@${config.configuradoPor}>` : '';
    embed.setDescription(`Último cambio ${when}${who}.`);
  } else {
    embed.setDescription('Nadie ha configurado este servidor todavía. Empieza por `/config oficial` y `/config gremio`.');
  }
  return embed;
}

/**
 * Respuesta a un cambio de /config: antes y después, y lo que sigue faltando.
 * @param {{ label: string, before: string, after: string, note?: string | null, config: object, guild?: import('discord.js').Guild | null }} params
 */
export function buildConfigChangeEmbed({ label, before, after, note = null, config, guild = null }) {
  const pending = CONFIG_FIELDS.filter(
    (field) => field.required && fieldStatus(field, config[field.key], guild) !== 'set',
  ).map((field) => `\`/config ${field.sub}\``);

  const lines = [`**Antes:** ${before}`, `**Ahora:** ${after}`];
  if (note) lines.push('', note);
  lines.push(
    '',
    pending.length > 0
      ? `Todavía falta: ${pending.join(', ')}. Mira \`/config ver\`.`
      : '✅ Ya no falta nada obligatorio.',
  );

  return new EmbedBuilder().setColor(CHANGE_COLOR).setTitle(`⚙️ ${label}`).setDescription(lines.join('\n'));
}
