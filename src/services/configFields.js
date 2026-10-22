import { getConfig } from './guildStore.js';

// Los campos del config.json de un servidor que se editan con /config: cómo
// se llaman de cara al usuario, con qué subcomando se fijan y qué deja de
// funcionar mientras falten. /config ver y los mensajes de "falta X" de los
// demás comandos salen de aquí, así que no pueden contradecirse.
//
//   required: sin él, algún comando no funciona (o no queda rastro de nada)
//   blocks:   comandos que se niegan a funcionar mientras falte
//   impact:   qué pasa mientras falte, para los que no bloquean nada

/**
 * @typedef {object} ConfigField
 * @property {string} key - campo de config.json
 * @property {string} sub - subcomando de /config que lo fija (y su nombre en /config reset)
 * @property {string} label
 * @property {'role' | 'channel' | 'text'} kind
 * @property {boolean} required
 * @property {string[]} blocks
 * @property {string | null} impact
 * @property {string} missing - frase para "este servidor no tiene..."
 */

/** @type {ConfigField[]} */
export const CONFIG_FIELDS = [
  {
    key: 'officerRoleId',
    sub: 'oficial',
    label: 'Rol de oficiales',
    kind: 'role',
    required: true,
    blocks: ['/squads', '/sorteo', '/crear-rol', '/health'],
    impact: null,
    missing: 'Este servidor no tiene rol de oficiales configurado.',
  },
  {
    key: 'logChannelId',
    sub: 'logs',
    label: 'Canal de logs',
    kind: 'channel',
    required: true,
    blocks: [],
    impact: 'Los cambios (/squads, /config, /crear-rol, /dm) y los errores no quedan registrados en ningún sitio.',
    missing: 'Este servidor no tiene canal de logs configurado.',
  },
  {
    key: 'raffleRoleId',
    sub: 'sorteo-rol',
    label: 'Rol a avisar en sorteos',
    kind: 'role',
    required: false,
    blocks: [],
    impact: '/sorteo funciona, pero no menciona a ningún rol al anunciarse.',
    missing: 'Este servidor no tiene rol de sorteos configurado.',
  },
  {
    key: 'dmOptoutRoleId',
    sub: 'dm-optout',
    label: 'Rol que no recibe /dm',
    kind: 'role',
    required: false,
    blocks: [],
    impact: '/dm funciona, pero nadie puede excluirse de recibirlos.',
    missing: 'Este servidor no tiene rol de exclusión de /dm configurado.',
  },
  {
    key: 'albionServer',
    sub: 'servidor',
    label: 'Servidor de Albion',
    kind: 'text',
    required: true,
    blocks: [],
    impact: null,
    missing: 'Este servidor no tiene servidor de Albion configurado.',
  },
  {
    key: 'albionGuild',
    sub: 'gremio',
    label: 'Gremio de Albion',
    kind: 'text',
    required: true,
    blocks: ['/getkills'],
    impact: null,
    missing: 'Este servidor no tiene gremio de Albion configurado.',
  },
  {
    key: 'albionbbGuildId',
    sub: 'albionbb',
    label: 'Id del gremio en albionbb',
    kind: 'text',
    required: true,
    blocks: ['/attendance'],
    impact: null,
    missing: 'Este servidor no tiene configurado el id de su gremio en albionbb.',
  },
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
 * ¿Tiene el servidor todos los campos obligatorios? No mira si un rol o canal
 * configurado sigue existiendo (eso necesita el servidor de Discord a mano;
 * lo hace /config ver).
 * @param {object} config
 */
export function isConfigComplete(config) {
  return CONFIG_FIELDS.every((field) => !field.required || Boolean(config[field.key]));
}

/**
 * "Este servidor no tiene X. Un administrador puede ponerlo con /config y."
 * @param {string} key
 */
export function missingConfigMessage(key) {
  const field = fieldByKey(key);
  return `${field.missing} Un administrador puede ponerlo con \`/config ${field.sub}\`.`;
}

/**
 * Un comando no puede funcionar porque a la config de su servidor le falta
 * un campo. No es un fallo del bot: el mensaje dice qué falta y con qué
 * comando se arregla, y lo ve quien lo ejecutó (no solo los oficiales).
 */
export class MissingConfigError extends Error {
  /** @param {string} key */
  constructor(key) {
    super(missingConfigMessage(key));
    this.name = 'MissingConfigError';
    this.key = key;
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
