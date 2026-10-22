import { readdir, stat, access } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../dataPaths.js';
import { withFileLock, readJsonFile, atomicWriteJson } from './fileStore.js';

// Configuración y datos aislados por servidor de Discord:
//
//   DATA_DIR/guilds/<guildId>/config.json | squads.json | raffles.json | backups/
//
// Toda ruta de un fichero de servidor sale de rutaDe(): es el único sitio que
// sabe construirla y el único que valida el guildId (un id que no sea un
// snowflake nunca llega a tocar el disco, ni para leer).

export const GUILDS_DIR_NAME = 'guilds';
export const CONFIG_VERSION = 1;
export const ALBION_SERVERS = new Set(['europe', 'americas', 'asia']);

const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
// Solo nombres planos ("squads.json", "backups"): nada de separadores ni "..".
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Campos que setConfig() deja cambiar. version y guildId los fija el bot.
const EDITABLE_KEYS = new Set([
  'nombre',
  'activo',
  'inactivoDesde',
  'officerRoleId',
  'logChannelId',
  'raffleRoleId',
  'dmOptoutRoleId',
  'albionServer',
  'albionGuild',
  'albionbbGuildId',
  'configuradoEn',
  'configuradoPor',
]);

export class GuildConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GuildConfigError';
  }
}

/**
 * Config de un servidor recién visto: nada configurado todavía.
 * @param {string} guildId
 */
export function defaultConfig(guildId) {
  return {
    version: CONFIG_VERSION,
    guildId,
    nombre: null,
    activo: true,
    // Fecha (ISO) en que echaron al bot del servidor; null mientras está dentro.
    inactivoDesde: null,
    officerRoleId: null,
    logChannelId: null,
    raffleRoleId: null,
    dmOptoutRoleId: null,
    albionServer: 'europe',
    albionGuild: null,
    albionbbGuildId: null,
    configuradoEn: null,
    configuradoPor: null,
  };
}

/**
 * @param {unknown} guildId
 * @returns {asserts guildId is string}
 */
export function assertGuildId(guildId) {
  if (typeof guildId !== 'string' || !SNOWFLAKE_PATTERN.test(guildId)) {
    throw new GuildConfigError(`guildId inválido: ${JSON.stringify(guildId)}`);
  }
}

/**
 * Igual que rutaDe() pero bajo una carpeta de servidores explícita (la que
 * contiene una subcarpeta por guildId). Solo para la migración, que monta la
 * estructura en una carpeta temporal antes de renombrarla a guilds/.
 * @param {string} guildsDir
 * @param {string} guildId
 * @param {string} [fichero]
 */
export function rutaEnCarpeta(guildsDir, guildId, fichero) {
  assertGuildId(guildId);
  const guildDir = path.join(guildsDir, guildId);
  if (fichero === undefined) return guildDir;
  if (typeof fichero !== 'string' || !FILE_NAME_PATTERN.test(fichero) || fichero.includes('..')) {
    throw new GuildConfigError(`Nombre de fichero inválido: ${JSON.stringify(fichero)}`);
  }
  return path.join(guildDir, fichero);
}

/**
 * Ruta de un fichero (o del directorio, sin `fichero`) de un servidor.
 * @param {string} guildId
 * @param {string} [fichero] - "config.json", "squads.json", "raffles.json", "backups"
 */
export function rutaDe(guildId, fichero) {
  return rutaEnCarpeta(path.join(DATA_DIR, GUILDS_DIR_NAME), guildId, fichero);
}

// --- caché: guildId -> { mtimeMs, config } ---
//
// Indexada por guildId, NUNCA una variable suelta: una caché sin indexar no
// falla con un error, devuelve la config del servidor equivocado. El mtime
// hace que una edición a mano de config.json se note sin reiniciar.

/** @type {Map<string, { mtimeMs: number, config: object }>} */
const cache = new Map();

/**
 * Invalida la caché de config de UN servidor (los demás no se tocan).
 * @param {string} guildId
 */
export function invalidateGuildConfigCache(guildId) {
  cache.delete(guildId);
}

async function readConfigFromDisk(guildId) {
  const filePath = rutaDe(guildId, 'config.json');
  const raw = await readJsonFile(filePath, null);
  if (raw === null) {
    const config = defaultConfig(guildId);
    await atomicWriteJson(filePath, config);
    return config;
  }
  // Campos que falten (config escrita por una versión anterior) toman el
  // valor por defecto; guildId siempre es el de la carpeta, no el del JSON.
  return { ...defaultConfig(guildId), ...raw, guildId };
}

async function cacheConfig(guildId, config) {
  const { mtimeMs } = await stat(rutaDe(guildId, 'config.json'));
  cache.set(guildId, { mtimeMs, config });
}

/**
 * Config del servidor. Si no existe config.json lo crea con los valores por
 * defecto: nunca devuelve null, un servidor sin configurar es un servidor con
 * la config vacía. Devuelve una copia: mutarla no toca la caché.
 * @param {string} guildId
 * @returns {Promise<ReturnType<typeof defaultConfig>>}
 */
export async function getConfig(guildId) {
  assertGuildId(guildId);
  const filePath = rutaDe(guildId, 'config.json');

  const cached = cache.get(guildId);
  if (cached) {
    const stats = await stat(filePath).catch(() => null);
    if (stats && stats.mtimeMs === cached.mtimeMs) return structuredClone(cached.config);
  }

  // Bajo el candado del fichero: dos primeras lecturas simultáneas no pueden
  // crear el fichero dos veces, ni leerlo a mitad de un setConfig().
  return withFileLock(filePath, async () => {
    const config = await readConfigFromDisk(guildId);
    await cacheConfig(guildId, config);
    return structuredClone(config);
  });
}

function validateChanges(cambios) {
  if (cambios === null || typeof cambios !== 'object' || Array.isArray(cambios)) {
    throw new GuildConfigError('Los cambios de config deben ser un objeto.');
  }
  for (const [key, value] of Object.entries(cambios)) {
    if (!EDITABLE_KEYS.has(key)) {
      throw new GuildConfigError(`Campo de config no editable o desconocido: "${key}".`);
    }
    if (key === 'activo') {
      if (typeof value !== 'boolean') throw new GuildConfigError('"activo" debe ser true o false.');
    } else if (key === 'albionServer') {
      if (!ALBION_SERVERS.has(value)) {
        throw new GuildConfigError(`"albionServer" debe ser uno de: ${[...ALBION_SERVERS].join(', ')}.`);
      }
    } else if (value !== null && typeof value !== 'string') {
      throw new GuildConfigError(`"${key}" debe ser un texto o null.`);
    }
  }
}

/**
 * Aplica `cambios` sobre la config actual del servidor (leída del disco bajo
 * el candado, no de la caché) y la guarda. Solo toca el config.json de ese
 * servidor.
 * @param {string} guildId
 * @param {Partial<ReturnType<typeof defaultConfig>>} cambios
 * @returns {Promise<ReturnType<typeof defaultConfig>>} la config resultante
 */
export async function setConfig(guildId, cambios) {
  return (await updateConfig(guildId, cambios)).config;
}

/**
 * Como setConfig(), pero devuelve también la config de antes del cambio,
 * leída bajo el mismo candado: el "antes" de un log no puede ser el de otra
 * escritura que se colara entre medias.
 * @param {string} guildId
 * @param {Partial<ReturnType<typeof defaultConfig>>} cambios
 * @returns {Promise<{ previous: ReturnType<typeof defaultConfig>, config: ReturnType<typeof defaultConfig> }>}
 */
export async function updateConfig(guildId, cambios) {
  assertGuildId(guildId);
  validateChanges(cambios);
  const filePath = rutaDe(guildId, 'config.json');

  return withFileLock(filePath, async () => {
    const current = await readConfigFromDisk(guildId);
    const next = { ...current, ...cambios, version: CONFIG_VERSION, guildId };
    await atomicWriteJson(filePath, next);
    await cacheConfig(guildId, next);
    return { previous: structuredClone(current), config: structuredClone(next) };
  });
}

/**
 * Un servidor está configurado cuando alguien (o la migración) lo marcó como
 * tal: configuradoEn no es null.
 * @param {string} guildId
 */
export async function estaConfigurado(guildId) {
  return (await getConfig(guildId)).configuradoEn !== null;
}

/**
 * ¿Tiene ya este servidor config.json? Distingue un servidor nuevo de uno
 * que vuelve (cuyos datos se conservaron al echar al bot).
 * @param {string} guildId
 */
export async function existeConfig(guildId) {
  try {
    await access(rutaDe(guildId, 'config.json'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Ids de los servidores que tienen carpeta en DATA_DIR/guilds/.
 * @returns {Promise<string[]>}
 */
export async function listarGuilds() {
  let entries;
  try {
    entries = await readdir(path.join(DATA_DIR, GUILDS_DIR_NAME), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && SNOWFLAKE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}
