import { EmbedBuilder } from 'discord.js';
import { CONFIG_FIELDS, fieldLabel, fieldGap } from '../services/configFields.js';
import { t } from '../i18n.js';

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
 * Un valor tal cual, para mostrar: mención de rol o de canal, el nombre del
 * idioma, o el texto (gremios y servidores de Albion no se traducen).
 * @param {import('../services/configFields.js').ConfigField} field
 * @param {string | null} value
 * @param {string} lang
 */
export function formatValue(field, value, lang) {
  if (!value) return t('common.notConfigured', lang);
  if (field.kind === 'role') return `<@&${value}>`;
  if (field.kind === 'channel') return `<#${value}>`;
  if (field.kind === 'language') return t(`common.language.${value}`, lang);
  return `\`${value}\``;
}

function formatFieldForView(field, value, status, lang) {
  if (status === 'missing') return t(field.required ? 'config.view.missingRequired' : 'config.view.missingOptional', lang);
  if (status === 'broken') {
    return t(field.kind === 'role' ? 'config.view.brokenRole' : 'config.view.brokenChannel', lang, { id: value });
  }
  return `✅ ${formatValue(field, value, lang)}`;
}

/**
 * Lo que falta (o está roto) y qué deja de funcionar por ello, una línea por
 * campo. Vacío si no falta nada.
 * @param {object} config
 * @param {import('discord.js').Guild | null} guild
 * @param {string} lang
 * @returns {string[]}
 */
export function describeGaps(config, guild, lang) {
  return CONFIG_FIELDS.filter((field) => fieldStatus(field, config[field.key], guild) !== 'set').map((field) =>
    fieldGap(field, lang),
  );
}

/**
 * /config view: cada campo con su valor (o marcado si falta) y, al final, qué
 * comandos no funcionan todavía por lo que falta.
 * @param {{ config: object, guild?: import('discord.js').Guild | null, lang: string }} params
 */
export function buildConfigViewEmbed({ config, guild = null, lang }) {
  const gaps = describeGaps(config, guild, lang);
  const blocking = CONFIG_FIELDS.some(
    (field) => field.required && fieldStatus(field, config[field.key], guild) !== 'set',
  );

  const embed = new EmbedBuilder()
    .setColor(blocking ? PENDING_COLOR : OK_COLOR)
    .setTitle(t('config.view.title', lang))
    .addFields(
      CONFIG_FIELDS.map((field) => ({
        name: t('config.view.fieldName', lang, { label: fieldLabel(field, lang), sub: field.sub }),
        value: formatFieldForView(field, config[field.key], fieldStatus(field, config[field.key], guild), lang),
        inline: false,
      })),
    )
    .addFields({
      name: t(gaps.length > 0 ? 'config.view.gapsTitle' : 'config.view.statusTitle', lang),
      value: gaps.length > 0 ? gaps.join('\n').slice(0, 1024) : t('config.view.allSet', lang),
      inline: false,
    });

  if (config.configuradoEn) {
    const when = `<t:${Math.floor(new Date(config.configuradoEn).getTime() / 1000)}:R>`;
    embed.setDescription(
      config.configuradoPor
        ? t('config.view.lastChange', lang, { when, who: `<@${config.configuradoPor}>` })
        : t('config.view.lastChangeNoActor', lang, { when }),
    );
  } else {
    embed.setDescription(t('config.view.neverConfigured', lang));
  }
  return embed;
}

/**
 * Respuesta a un cambio de /config: antes y después, y lo que sigue faltando.
 * @param {{ field: import('../services/configFields.js').ConfigField, before: string | null, after: string | null, note?: string | null, config: object, guild?: import('discord.js').Guild | null, lang: string }} params
 */
export function buildConfigChangeEmbed({ field, before, after, note = null, config, guild = null, lang }) {
  const pending = CONFIG_FIELDS.filter(
    (candidate) => candidate.required && fieldStatus(candidate, config[candidate.key], guild) !== 'set',
  ).map((candidate) => `\`/config ${candidate.sub}\``);

  const lines = [
    t('config.change.before', lang, { value: formatValue(field, before, lang) }),
    t('config.change.after', lang, { value: formatValue(field, after, lang) }),
  ];
  if (note) lines.push('', note);
  lines.push(
    '',
    pending.length > 0 ? t('config.change.pending', lang, { subs: pending.join(', ') }) : t('config.change.complete', lang),
  );

  return new EmbedBuilder()
    .setColor(CHANGE_COLOR)
    .setTitle(`⚙️ ${fieldLabel(field, lang)}`)
    .setDescription(lines.join('\n'));
}
