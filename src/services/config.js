import { readFile, stat } from 'node:fs/promises';

const MIN_NAME_LENGTH = 3;
const MAX_NAME_LENGTH = 16;
const ROOT_KEYS = new Set(['guilds', 'squads']);

export class ConfigError extends Error {
  constructor(message, { path, reason } = {}) {
    super(message);
    this.name = 'ConfigError';
    this.path = path;
    this.reason = reason;
  }
}

/**
 * @typedef {object} SquadEntry
 * @property {string} display - clave del squad en MAYÚSCULA, para mostrar en el embed
 * @property {Set<string>} members - nombres de jugador (lowercase)
 */

/**
 * @typedef {object} ConfigData
 * @property {Set<string>} guilds - nombres de gremio (lowercase)
 * @property {string[]} squadOrder - claves de squad (lowercase), en el orden del fichero
 * @property {Map<string, SquadEntry>} squads - clave de squad (lowercase) -> entrada
 * @property {Map<string, string>} playerToSquad - nombre de jugador (lowercase) -> clave de squad (lowercase)
 * @property {string[]} warnings - avisos no bloqueantes (ej. jugador repetido en varios squads)
 */

/** @type {{ path: string, mtimeMs: number, data: ConfigData } | null} */
let cache = null;

export { MIN_NAME_LENGTH, MAX_NAME_LENGTH };

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isValidPlayerName(value) {
  if (typeof value !== 'string') return false;
  const length = value.trim().length;
  return length >= MIN_NAME_LENGTH && length <= MAX_NAME_LENGTH;
}

/**
 * Valida y normaliza el objeto crudo { guilds, squads } a la estructura
 * optimizada para lookup O(1) que usa la agregación. Exportada para que
 * services/squadsStore.js reutilice exactamente esta misma validación antes
 * de sobrescribir squads.json.
 * @param {unknown} raw
 * @param {string} path
 * @returns {ConfigData}
 */
export function normalizeConfig(raw, path) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`El archivo de configuración "${path}" debe contener un objeto raíz`, {
      path,
      reason: 'invalid_root',
    });
  }

  const rootKeys = new Set(Object.keys(raw));
  const hasExactlyAllowedKeys =
    rootKeys.size === ROOT_KEYS.size && [...ROOT_KEYS].every((key) => rootKeys.has(key));
  if (!hasExactlyAllowedKeys) {
    throw new ConfigError(
      `El archivo "${path}" debe tener exactamente las claves "guilds" y "squads" (encontradas: ${[...rootKeys].join(', ') || 'ninguna'})`,
      { path, reason: 'invalid_root_keys' },
    );
  }

  if (!Array.isArray(raw.guilds) || raw.guilds.length === 0) {
    throw new ConfigError(`"guilds" en "${path}" debe ser un array no vacío`, {
      path,
      reason: 'invalid_guilds',
    });
  }

  const guilds = new Set();
  for (const guildName of raw.guilds) {
    if (!isNonEmptyString(guildName)) {
      throw new ConfigError(`"guilds" en "${path}" contiene un nombre de gremio inválido: ${JSON.stringify(guildName)}`, {
        path,
        reason: 'invalid_guild_name',
      });
    }
    guilds.add(guildName.trim().toLowerCase());
  }

  if (raw.squads === null || typeof raw.squads !== 'object' || Array.isArray(raw.squads)) {
    throw new ConfigError(`"squads" en "${path}" debe ser un objeto`, { path, reason: 'invalid_squads' });
  }

  const squadOrder = [];
  const squads = new Map();
  const playerToSquad = new Map();
  const warnings = [];

  for (const [squadKeyRaw, members] of Object.entries(raw.squads)) {
    const key = squadKeyRaw.toLowerCase();

    if (squads.has(key)) {
      throw new ConfigError(
        `El squad "${squadKeyRaw}" en "${path}" está duplicado (case-insensitive)`,
        { path, reason: 'duplicate_squad' },
      );
    }

    if (!Array.isArray(members)) {
      throw new ConfigError(`El squad "${squadKeyRaw}" en "${path}" debe ser un array de nombres`, {
        path,
        reason: 'invalid_squad_value',
      });
    }

    const memberSet = new Set();
    for (const member of members) {
      if (!isValidPlayerName(member)) {
        throw new ConfigError(
          `El squad "${squadKeyRaw}" en "${path}" contiene un nombre de jugador inválido: ${JSON.stringify(member)} ` +
            `(debe ser un string de ${MIN_NAME_LENGTH} a ${MAX_NAME_LENGTH} caracteres)`,
          { path, reason: 'invalid_member' },
        );
      }

      const memberKey = member.trim().toLowerCase();
      memberSet.add(memberKey);

      if (playerToSquad.has(memberKey) && playerToSquad.get(memberKey) !== key) {
        warnings.push(
          `El jugador "${member.trim()}" está en varios squads: "${playerToSquad.get(memberKey)}" y "${key}" (se mantiene "${playerToSquad.get(memberKey)}")`,
        );
      } else {
        playerToSquad.set(memberKey, key);
      }
    }

    squadOrder.push(key);
    squads.set(key, { display: squadKeyRaw.toUpperCase(), members: memberSet });
  }

  return { guilds, squadOrder, squads, playerToSquad, warnings };
}

/**
 * Carga (y cachea) el archivo de configuración de squads/guilds desde `path`.
 * @param {string} path
 * @returns {Promise<ConfigData>}
 * @throws {ConfigError} si el archivo no existe o no valida
 */
export async function loadConfig(path) {
  let stats;
  try {
    stats = await stat(path);
  } catch (error) {
    throw new ConfigError(`No se pudo acceder al archivo de configuración en "${path}": ${error.message}`, {
      path,
      reason: error.code === 'ENOENT' ? 'not_found' : 'stat_error',
    });
  }

  if (cache && cache.path === path && cache.mtimeMs === stats.mtimeMs) {
    return cache.data;
  }

  let raw;
  try {
    const content = await readFile(path, 'utf8');
    raw = JSON.parse(content);
  } catch (error) {
    throw new ConfigError(`No se pudo leer o parsear "${path}": ${error.message}`, {
      path,
      reason: 'parse_error',
    });
  }

  const data = normalizeConfig(raw, path);
  cache = { path, mtimeMs: stats.mtimeMs, data };
  return data;
}

/**
 * Invalida la caché en memoria de loadConfig, forzando una relectura del
 * archivo en la próxima llamada. Debe invocarse tras editar squads.json.
 */
export function invalidateConfigCache() {
  cache = null;
}
