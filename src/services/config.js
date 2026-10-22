import { readFile, stat } from 'node:fs/promises';
import { rutaDe, getConfig, setConfig } from './guildStore.js';
import { withFileLock, backupCurrentFile, atomicWriteJson } from './fileStore.js';
import { LocalizedError, t, DEFAULT_LANGUAGE } from '../i18n.js';

const MIN_NAME_LENGTH = 3;
const MAX_NAME_LENGTH = 16;
const MAX_GUILD_NAME_LENGTH = 64;
const ROOT_KEYS = new Set(['squads']);
const SQUAD_KEYS = new Set(['isGuild', 'members']);

/**
 * squads.json no se puede leer o no valida. El texto sale de src/i18n.js
 * (configFile.*); `reason` es para el código y el log.
 */
export class ConfigError extends LocalizedError {
  /**
   * @param {string} key
   * @param {Record<string, string | number>} values
   * @param {{ path?: string, reason?: string }} [meta]
   */
  constructor(key, values, { path, reason } = {}) {
    super(key, values);
    this.name = 'ConfigError';
    this.path = path;
    this.reason = reason;
  }
}

/**
 * Dos tipos de squad en squads.json:
 *
 *   "foab":     { "isGuild": false, "members": ["FokinFran", "DanyHM"] }
 *   "Dementia": { "isGuild": true,  "members": [] }
 *
 * isGuild es obligatorio y explícito: un squad de jugadores recién creado
 * tiene members vacío y NO por eso pasa a ser un gremio. Con isGuild en true
 * la clave del squad ES el nombre del gremio de Albion (casing original, con
 * espacios si los tiene) y members se ignora. Por eso renombrar un squad de
 * gremio cambia a qué gremio sigue.
 *
 * @typedef {object} SquadEntry
 * @property {string} display - para mostrar: la clave en MAYÚSCULA (jugadores) o el nombre del gremio tal cual (gremio)
 * @property {boolean} isGuild
 * @property {Map<string, string>} members - jugador en minúsculas (para comparar) -> su nombre tal cual está en
 *   squads.json (para mostrar); siempre vacío si isGuild
 * @property {string | null} guildName - nombre del gremio con su casing original, o null si es de jugadores
 */

/**
 * @typedef {object} ConfigData
 * @property {string[]} squadOrder - claves de squad (lowercase), en el orden del fichero, de ambos tipos
 * @property {Map<string, SquadEntry>} squads - clave de squad (lowercase) -> entrada
 * @property {Map<string, string>} playerToSquad - jugador (lowercase) -> clave de squad de JUGADORES (lowercase)
 * @property {Map<string, string>} guildToSquad - gremio (lowercase) -> clave de squad de GREMIO (lowercase)
 * @property {Array<{ key: string, values: object }>} notices - avisos no bloqueantes (ej. jugador repetido en
 *   varios squads), como clave de i18n: /health los enseña en el idioma de quien lo lee
 * @property {string[]} warnings - los mismos avisos en inglés, para el log
 */

// Indexada por guildId: una caché suelta devolvería los squads de otro
// servidor sin dar ningún error.
/** @type {Map<string, { mtimeMs: number, data: ConfigData }>} */
const cache = new Map();

export { MIN_NAME_LENGTH, MAX_NAME_LENGTH, MAX_GUILD_NAME_LENGTH };

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isValidPlayerName(value) {
  if (typeof value !== 'string') return false;
  const length = value.trim().length;
  return length >= MIN_NAME_LENGTH && length <= MAX_NAME_LENGTH;
}

/**
 * Nombre de gremio de Albion válido como clave de un squad de gremio: puede
 * llevar espacios, mayúsculas y ser numérico, pero no espacios al principio
 * o al final (la comparación es por igualdad exacta, y un espacio de más
 * haría que no casara nunca).
 */
export function isValidGuildName(value) {
  if (typeof value !== 'string') return false;
  return value.length > 0 && value.length <= MAX_GUILD_NAME_LENGTH && value.trim() === value;
}

/**
 * Valida y normaliza el objeto crudo { squads } a la estructura optimizada
 * para lookup O(1) que usa la agregación. Exportada para que
 * services/squadsStore.js reutilice exactamente esta misma validación antes
 * de sobrescribir squads.json.
 * @param {unknown} raw
 * @param {string} path
 * @returns {ConfigData}
 */
export function normalizeConfig(raw, path) {
  if (!isPlainObject(raw)) {
    throw new ConfigError('configFile.root', { path }, { path, reason: 'invalid_root' });
  }

  const rootKeys = Object.keys(raw);
  if (rootKeys.length !== ROOT_KEYS.size || !rootKeys.every((key) => ROOT_KEYS.has(key))) {
    throw new ConfigError(
      'configFile.rootKeys',
      { path, keys: rootKeys.join(', ') || '—' },
      { path, reason: 'invalid_root_keys' },
    );
  }

  if (!isPlainObject(raw.squads)) {
    throw new ConfigError('configFile.squadsNotObject', { path }, { path, reason: 'invalid_squads' });
  }

  const squadOrder = [];
  const squads = new Map();
  const playerToSquad = new Map();
  const guildToSquad = new Map();
  const notices = [];

  for (const [squadKeyRaw, entry] of Object.entries(raw.squads)) {
    const key = squadKeyRaw.toLowerCase();

    if (squads.has(key)) {
      throw new ConfigError('configFile.duplicateSquad', { squad: squadKeyRaw, path }, { path, reason: 'duplicate_squad' });
    }

    const entryKeys = isPlainObject(entry) ? Object.keys(entry) : [];
    if (!isPlainObject(entry) || entryKeys.length !== SQUAD_KEYS.size || !entryKeys.every((k) => SQUAD_KEYS.has(k))) {
      throw new ConfigError('configFile.squadShape', { squad: squadKeyRaw, path }, { path, reason: 'invalid_squad_value' });
    }
    if (typeof entry.isGuild !== 'boolean') {
      throw new ConfigError('configFile.isGuildType', { squad: squadKeyRaw, path }, { path, reason: 'invalid_is_guild' });
    }
    if (!Array.isArray(entry.members)) {
      throw new ConfigError('configFile.membersType', { squad: squadKeyRaw, path }, { path, reason: 'invalid_members' });
    }

    if (entry.isGuild) {
      if (!isValidGuildName(squadKeyRaw)) {
        throw new ConfigError(
          'configFile.guildName',
          { squad: squadKeyRaw, path, max: MAX_GUILD_NAME_LENGTH },
          { path, reason: 'invalid_guild_name' },
        );
      }
      if (entry.members.length > 0) {
        notices.push({
          key: `configFile.warning.guildMembers.${entry.members.length === 1 ? 'one' : 'other'}`,
          values: { squad: squadKeyRaw, count: entry.members.length },
        });
      }
      guildToSquad.set(key, key);
      squadOrder.push(key);
      squads.set(key, { display: squadKeyRaw, isGuild: true, members: new Map(), guildName: squadKeyRaw });
      continue;
    }

    // La clave en minúsculas es solo para comparar; el valor es el nombre que
    // se muestra. Si un nombre se repite con otro casing, manda el primero.
    const memberMap = new Map();
    for (const member of entry.members) {
      if (!isValidPlayerName(member)) {
        throw new ConfigError(
          'configFile.member',
          { squad: squadKeyRaw, path, member: JSON.stringify(member), min: MIN_NAME_LENGTH, max: MAX_NAME_LENGTH },
          { path, reason: 'invalid_member' },
        );
      }

      const memberKey = member.trim().toLowerCase();
      if (!memberMap.has(memberKey)) memberMap.set(memberKey, member.trim());

      if (playerToSquad.has(memberKey) && playerToSquad.get(memberKey) !== key) {
        notices.push({
          key: 'configFile.warning.playerInSeveral',
          values: { player: member.trim(), kept: playerToSquad.get(memberKey), other: key },
        });
      } else {
        playerToSquad.set(memberKey, key);
      }
    }

    squadOrder.push(key);
    squads.set(key, { display: squadKeyRaw.toUpperCase(), isGuild: false, members: memberMap, guildName: null });
  }

  const warnings = notices.map(({ key, values }) => t(key, DEFAULT_LANGUAGE, values));
  return { squadOrder, squads, playerToSquad, guildToSquad, notices, warnings };
}

// --- migración del formato viejo ---
//
// Formato viejo: { "guilds": ["VIPS", "Otro"], "squads": { "foab": ["a", "b"] } }
//   - cada squad era un array de nombres -> { isGuild: false, members: [...] }
//   - "guilds" era la lista de gremios trackeados. El principal ya vive en
//     config.json del servidor (albionGuild); el resto pasan a squads de
//     gremio, que es lo que realmente son. Nada se descarta.

/**
 * ¿Está `raw` (todo o en parte) en el formato viejo?
 * @param {unknown} raw
 */
export function isLegacySquadsConfig(raw) {
  if (!isPlainObject(raw)) return false;
  if ('guilds' in raw) return true;
  return isPlainObject(raw.squads) && Object.values(raw.squads).some((value) => Array.isArray(value));
}

/**
 * Convierte el formato viejo al nuevo sin perder nada. Pura: no toca disco.
 * @param {object} raw
 * @param {{ mainGuild: string | null }} options - albionGuild actual del servidor
 * @returns {{ data: { squads: Record<string, { isGuild: boolean, members: string[] }> }, mainGuild: string | null, notes: string[] }}
 *   mainGuild: el gremio principal resultante (el que ya había, o el primero de la lista vieja si no había)
 * @throws {ConfigError} si un gremio viejo choca con un squad de jugadores del mismo nombre (no se puede convertir sin perder uno de los dos)
 */
export function migrateLegacySquads(raw, { mainGuild }) {
  const notes = [];
  const squads = {};

  for (const [key, value] of Object.entries(isPlainObject(raw.squads) ? raw.squads : {})) {
    squads[key] = Array.isArray(value) ? { isGuild: false, members: [...value] } : value;
  }

  const legacyGuilds = (Array.isArray(raw.guilds) ? raw.guilds : [])
    .filter((name) => typeof name === 'string' && name.trim().length > 0)
    .map((name) => name.trim());

  let resolvedMain = mainGuild;
  if (!resolvedMain && legacyGuilds.length > 0) {
    resolvedMain = legacyGuilds[0];
    notes.push(`El servidor no tenía gremio principal: albionGuild = "${resolvedMain}" (el primero de la lista vieja).`);
  }

  for (const guildName of legacyGuilds) {
    if (resolvedMain && guildName.toLowerCase() === resolvedMain.toLowerCase()) continue;
    const clash = Object.keys(squads).find((key) => key.toLowerCase() === guildName.toLowerCase());
    if (clash) {
      if (squads[clash].isGuild) continue; // ya era un squad de gremio
      throw new ConfigError('configFile.migrationConflict', { guild: guildName, squad: clash }, { reason: 'migration_conflict' });
    }
    squads[guildName] = { isGuild: true, members: [] };
    notes.push(`El gremio "${guildName}" de la lista vieja pasa a ser un squad de gremio.`);
  }

  return { data: { squads }, mainGuild: resolvedMain ?? null, notes };
}

/**
 * Si el squads.json de `guildId` sigue en el formato viejo, lo convierte y lo
 * reescribe (con backup) bajo el candado del fichero. Idempotente: si otro ya
 * lo migró mientras esperaba el candado, no hace nada.
 * @param {string} guildId
 */
async function migrateFileIfLegacy(guildId) {
  const path = rutaDe(guildId, 'squads.json');
  await withFileLock(path, async () => {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    if (!isLegacySquadsConfig(raw)) return;
    await persistLegacyMigration(guildId, raw, path);
  });
}

/**
 * Convierte `raw` (formato viejo) y lo deja escrito en disco. Llamar SOLO con
 * el candado de squads.json ya tomado.
 * @param {string} guildId
 * @param {object} raw
 * @param {string} path
 * @returns {Promise<object>} el contenido nuevo
 */
export async function persistLegacyMigration(guildId, raw, path) {
  const { albionGuild } = await getConfig(guildId);
  let migrated;
  try {
    migrated = migrateLegacySquads(raw, { mainGuild: albionGuild });
  } catch (error) {
    if (error instanceof ConfigError) error.path = path;
    throw error;
  }
  normalizeConfig(migrated.data, path); // si no valida, no se toca nada

  if (migrated.mainGuild !== albionGuild) {
    await setConfig(guildId, { albionGuild: migrated.mainGuild });
  }
  await backupCurrentFile(path, 'squads');
  await atomicWriteJson(path, migrated.data);
  cache.delete(guildId);

  console.warn(
    `[squads] ${path} estaba en el formato viejo y se ha convertido (backup en su carpeta backups/). ` +
      [`Squads de array -> { isGuild: false, members }.`, ...migrated.notes].join(' '),
  );
  return migrated.data;
}

/**
 * Lee y valida un squads.json concreto, SIN caché. Para scripts y tests que
 * trabajan con un fichero suelto; el bot usa loadConfig(guildId).
 * @param {string} path
 * @returns {Promise<{ mtimeMs: number, data: ConfigData, legacy: boolean }>}
 * @throws {ConfigError} si el archivo no existe o no valida
 */
async function readConfigFile(path, { allowLegacy = false } = {}) {
  let stats;
  try {
    stats = await stat(path);
  } catch (error) {
    throw new ConfigError(
      'configFile.notFound',
      { path, detail: error.message },
      { path, reason: error.code === 'ENOENT' ? 'not_found' : 'stat_error' },
    );
  }

  let raw;
  try {
    const content = await readFile(path, 'utf8');
    raw = JSON.parse(content);
  } catch (error) {
    throw new ConfigError('configFile.parse', { path, detail: error.message }, { path, reason: 'parse_error' });
  }

  if (allowLegacy && isLegacySquadsConfig(raw)) {
    return { mtimeMs: stats.mtimeMs, data: null, legacy: true };
  }
  return { mtimeMs: stats.mtimeMs, data: normalizeConfig(raw, path), legacy: false };
}

/**
 * @param {string} path
 * @returns {Promise<ConfigData>}
 * @throws {ConfigError}
 */
export async function loadConfigFromFile(path) {
  return (await readConfigFile(path)).data;
}

/**
 * Carga (y cachea) el squads.json del servidor `guildId`. Si está en el
 * formato viejo lo convierte una vez, automáticamente y sin perder nada. Si
 * no existe, devuelve una config sin squads.
 * @param {string} guildId
 * @returns {Promise<ConfigData>}
 * @throws {ConfigError} si el archivo no se puede leer o no valida
 */
export async function loadConfig(guildId) {
  const path = rutaDe(guildId, 'squads.json');

  const cached = cache.get(guildId);
  if (cached) {
    const stats = await stat(path).catch(() => null);
    if (stats && stats.mtimeMs === cached.mtimeMs) return cached.data;
  }

  let result;
  try {
    result = await readConfigFile(path, { allowLegacy: true });
  } catch (error) {
    // Un servidor recién añadido todavía no tiene squads.json: no es un
    // error, es un servidor sin squads. El fichero se crea con el primer
    // /squads create.
    if (error instanceof ConfigError && error.reason === 'not_found') return normalizeConfig({ squads: {} }, path);
    throw error;
  }
  if (result.legacy) {
    await migrateFileIfLegacy(guildId);
    result = await readConfigFile(path);
  }
  cache.set(guildId, { mtimeMs: result.mtimeMs, data: result.data });
  return result.data;
}

/**
 * Invalida la caché en memoria de loadConfig para UN servidor, forzando una
 * relectura de su squads.json en la próxima llamada. Debe invocarse tras
 * editarlo. Los demás servidores no se tocan.
 * @param {string} guildId
 */
export function invalidateConfigCache(guildId) {
  cache.delete(guildId);
}
