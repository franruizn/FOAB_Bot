import { getConfig } from './guildStore.js';
import { LocalizedError, t, commandName } from '../i18n.js';

// Los campos del config.json de un servidor que se editan con /config: con
// qué subcomando se fijan y qué deja de funcionar mientras falten. /config
// view y los mensajes de "falta X" de los demás comandos salen de aquí, así
// que no pueden contradecirse. Los textos están en src/i18n.js, bajo
// config.field.<key>.label / .missing / .gap.
//
//   required: sin él, algún comando no funciona (o no queda rastro de nada)
//   blocks:   comandos (su clave en i18n: cmd.<clave>.name) que se niegan a
//             funcionar mientras falte

/**
 * @typedef {object} ConfigField
 * @property {string} key - campo de config.json
 * @property {string} sub - subcomando de /config que lo fija (y su valor en /config reset)
 * @property {'role' | 'channel' | 'text' | 'language'} kind
 * @property {boolean} required
 * @property {string[]} blocks
 */

/** @type {ConfigField[]} */
export const CONFIG_FIELDS = [
  { key: 'officerRoleId', sub: 'officer', kind: 'role', required: true, blocks: ['squads', 'raffle', 'createRole', 'health'] },
  { key: 'logChannelId', sub: 'logs', kind: 'channel', required: true, blocks: [] },
  { key: 'raffleRoleId', sub: 'raffle-role', kind: 'role', required: false, blocks: [] },
  { key: 'dmOptoutRoleId', sub: 'dm-optout', kind: 'role', required: false, blocks: [] },
  { key: 'albionServer', sub: 'server', kind: 'text', required: true, blocks: [] },
  { key: 'albionGuild', sub: 'guild', kind: 'text', required: true, blocks: ['getkills'] },
  { key: 'albionbbGuildId', sub: 'albionbb', kind: 'text', required: true, blocks: ['attendance'] },
  { key: 'idioma', sub: 'language', kind: 'language', required: false, blocks: [] },
];

const FIELDS_BY_KEY = new Map(CONFIG_FIELDS.map((field) => [field.key, field]));
const FIELDS_BY_SUB = new Map(CONFIG_FIELDS.map((field) => [field.sub, field]));

/** @param {string} key */
export function fieldByKey(key) {
  const field = FIELDS_BY_KEY.get(key);
  if (!field) throw new Error(`Campo de config desconocido: "${key}"`);
  return field;
}

/** @param {string} sub */
export function fieldBySub(sub) {
  return FIELDS_BY_SUB.get(sub) ?? null;
}

/**
 * Nombre del campo para mostrar.
 * @param {ConfigField} field
 * @param {string} lang
 */
export function fieldLabel(field, lang) {
  return t(`config.field.${field.key}.label`, lang);
}

/**
 * Qué deja de funcionar mientras falte el campo, con los comandos escritos
 * como los teclea quien lee ("/sorteo" en español, "/raffle" en inglés).
 * @param {ConfigField} field
 * @param {string} lang
 */
export function fieldGap(field, lang) {
  const commands = field.blocks.map((command) => commandName(command, lang)).join(', ');
  return t(`config.field.${field.key}.gap`, lang, { commands });
}

/**
 * ¿Tiene el servidor todos los campos obligatorios? No mira si un rol o canal
 * configurado sigue existiendo (eso necesita el servidor de Discord a mano;
 * lo hace /config view).
 * @param {object} config
 */
export function isConfigComplete(config) {
  return CONFIG_FIELDS.every((field) => !field.required || Boolean(config[field.key]));
}

/**
 * "Este servidor no tiene X. Un administrador puede ponerlo con /config y."
 * @param {string} key
 * @param {string} lang
 */
export function missingConfigMessage(key, lang) {
  return t(`config.field.${fieldByKey(key).key}.missing`, lang);
}

/**
 * Un comando no puede funcionar porque a la config de su servidor le falta
 * un campo. No es un fallo del bot: el mensaje dice qué falta y con qué
 * comando se arregla, y lo ve quien lo ejecutó (no solo los oficiales).
 */
export class MissingConfigError extends LocalizedError {
  /** @param {string} field - campo de config.json que falta */
  constructor(field) {
    super(`config.field.${fieldByKey(field).key}.missing`);
    this.name = 'MissingConfigError';
    this.field = field;
  }
}

/**
 * Config del servidor, exigiendo que `keys` estén puestos.
 * @param {string} guildId
 * @param {...string} keys
 * @throws {MissingConfigError} con el primer campo de `keys` que falte
 */
export async function requireConfig(guildId, ...keys) {
  const config = await getConfig(guildId);
  for (const key of keys) {
    if (!config[key]) throw new MissingConfigError(key);
  }
  return config;
}
