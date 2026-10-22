import {
  loadConfig,
  normalizeConfig,
  invalidateConfigCache,
  isValidPlayerName,
  isValidGuildName,
  isLegacySquadsConfig,
  persistLegacyMigration,
  MIN_NAME_LENGTH,
  MAX_NAME_LENGTH,
  MAX_GUILD_NAME_LENGTH,
} from './config.js';
import { withFileLock, readJsonFile, backupCurrentFile, atomicWriteJson } from './fileStore.js';
import { rutaDe, getConfig } from './guildStore.js';
import { LocalizedError } from '../i18n.js';

const SQUAD_KEY_MAX_LENGTH = 32;

/**
 * Entrada de /squads que no se puede aplicar. El texto sale de src/i18n.js
 * (squadsError.*) en el idioma de quien lo vaya a leer.
 */
export class SquadCommandError extends LocalizedError {
  /**
   * @param {string} key
   * @param {Record<string, string | number>} [values]
   */
  constructor(key, values) {
    super(key, values);
    this.name = 'SquadCommandError';
  }
}

// --- validación de entrada de usuario ---

/**
 * Normaliza y valida la clave de un squad de JUGADORES: minúsculas,
 * a-z/0-9/guiones, máx 32.
 * @param {string} input
 * @returns {string}
 */
export function normalizeSquadKey(input) {
  const key = String(input).trim().toLowerCase();
  if (key.length === 0 || key.length > SQUAD_KEY_MAX_LENGTH) {
    throw new SquadCommandError('squadsError.keyLength', { max: SQUAD_KEY_MAX_LENGTH });
  }
  for (const char of key) {
    const isLower = char >= 'a' && char <= 'z';
    const isDigit = char >= '0' && char <= '9';
    const isDash = char === '-';
    if (!isLower && !isDigit && !isDash) {
      throw new SquadCommandError('squadsError.keyChars', { key });
    }
  }
  return key;
}

/**
 * Normaliza el nombre de un squad de GREMIO, que es el nombre del gremio de
 * Albion: se conservan espacios y casing, solo se recortan los extremos.
 * @param {string} input
 * @returns {string}
 */
export function normalizeGuildSquadName(input) {
  const name = String(input).trim();
  if (!isValidGuildName(name)) {
    throw new SquadCommandError('squadsError.guildNameLength', { max: MAX_GUILD_NAME_LENGTH });
  }
  return name;
}

/** Clave para BUSCAR un squad existente (de cualquier tipo): sin validar formato. */
function lookupKey(input) {
  const key = String(input).trim().toLowerCase();
  if (key.length === 0) throw new SquadCommandError('squadsError.noSquad');
  return key;
}

function normalizePlayerName(input) {
  const name = String(input).trim();
  if (!isValidPlayerName(name)) {
    throw new SquadCommandError('squadsError.playerLength', { name: String(input), min: MIN_NAME_LENGTH, max: MAX_NAME_LENGTH });
  }
  return name;
}

function findSquadKeyCaseInsensitive(raw, keyLower) {
  return Object.keys(raw.squads).find((k) => k.toLowerCase() === keyLower) ?? null;
}

function findPlayerCurrentSquad(raw, nameLower) {
  for (const [squadKey, squad] of Object.entries(raw.squads)) {
    if (squad.isGuild) continue;
    if (squad.members.some((m) => m.toLowerCase() === nameLower)) return squadKey;
  }
  return null;
}

/**
 * @param {string} squadKey
 * @param {'add' | 'remove' | 'move'} action - una frase completa por acción en i18n
 */
function rejectGuildSquad(squadKey, action) {
  throw new SquadCommandError(`squadsError.guildSquad.${action}`, { squad: squadKey });
}

function sameName(a, b) {
  return Boolean(a) && Boolean(b) && a.toLowerCase() === b.toLowerCase();
}

async function rejectIfMainGuild(guildId, guildName) {
  const { albionGuild } = await getConfig(guildId);
  if (sameName(albionGuild, guildName)) {
    throw new SquadCommandError('squadsError.mainGuild', { guild: guildName });
  }
}

// --- lectura / escritura del fichero ---

/**
 * Aplica una mutación al squads.json del servidor `guildId` de forma segura:
 * 1. serializa con las demás escrituras de ESE fichero (otros servidores no
 *    esperan),
 * 2. lee el fichero actual del disco (nunca de la caché de config.js) y, si
 *    sigue en el formato viejo, lo convierte antes de nada,
 * 3. ejecuta mutateFn sobre una copia y valida el resultado con el mismo
 *    validador que usa loadConfig ANTES de tocar nada en disco,
 * 4. hace backup del fichero actual (en la carpeta backups/ del servidor) y
 *    solo entonces escribe atómicamente (tmp + rename), conservando las
 *    últimas 10 copias,
 * 5. invalida la caché de loadConfig de ese servidor.
 *
 * @param {string} guildId
 * @param {(raw: {squads: Record<string, { isGuild: boolean, members: string[] }>}) => { data: object, report: object }} mutateFn
 * @returns {Promise<{ data: object, report: object }>}
 */
export async function mutateSquadsConfig(guildId, mutateFn) {
  const filePath = rutaDe(guildId, 'squads.json');
  return withFileLock(filePath, async () => {
    // Sin squads.json (servidor recién añadido) se parte de uno vacío.
    let raw = await readJsonFile(filePath, { squads: {} });
    if (isLegacySquadsConfig(raw)) raw = await persistLegacyMigration(guildId, raw, filePath);

    const { data, report } = mutateFn(structuredClone(raw));

    // Si esto lanza (ConfigError), no se toca el fichero original.
    normalizeConfig(data, filePath);

    await backupCurrentFile(filePath, 'squads');
    await atomicWriteJson(filePath, data);
    invalidateConfigCache(guildId);

    return { data, report };
  });
}

// --- mutaciones de alto nivel ---

/**
 * @param {string} guildId
 * @param {string} nameInput
 * @param {{ isGuild?: boolean }} [options] - isGuild: el squad sigue al gremio de Albion que se llama igual
 */
export async function createSquad(guildId, nameInput, { isGuild = false } = {}) {
  const key = isGuild ? normalizeGuildSquadName(nameInput) : normalizeSquadKey(nameInput);
  if (isGuild) await rejectIfMainGuild(guildId, key);

  return mutateSquadsConfig(guildId, (raw) => {
    const existing = findSquadKeyCaseInsensitive(raw, key.toLowerCase());
    if (existing) {
      const kind = raw.squads[existing].isGuild ? 'guild' : 'players';
      throw new SquadCommandError(`squadsError.exists.${kind}`, { squad: existing });
    }
    return {
      data: { ...raw, squads: { ...raw.squads, [key]: { isGuild, members: [] } } },
      report: { key, isGuild },
    };
  });
}

export async function deleteSquad(guildId, squadKeyInput) {
  const key = lookupKey(squadKeyInput);
  return mutateSquadsConfig(guildId, (raw) => {
    const existingKey = findSquadKeyCaseInsensitive(raw, key);
    if (!existingKey) {
      throw new SquadCommandError('squadsError.notFound', { squad: squadKeyInput });
    }
    const { isGuild, members } = raw.squads[existingKey];
    const squads = { ...raw.squads };
    delete squads[existingKey];
    return { data: { ...raw, squads }, report: { key: existingKey, isGuild, removedMembers: members } };
  });
}

export async function addPlayers(guildId, squadKeyInput, playerNamesInput) {
  const key = lookupKey(squadKeyInput);
  const requestedNames = String(playerNamesInput)
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  if (requestedNames.length === 0) {
    throw new SquadCommandError('squadsError.noPlayers');
  }

  const normalizedNames = requestedNames.map(normalizePlayerName);

  return mutateSquadsConfig(guildId, (raw) => {
    const existingKey = findSquadKeyCaseInsensitive(raw, key);
    if (!existingKey) {
      throw new SquadCommandError('squadsError.notFoundCreate', { squad: squadKeyInput });
    }
    if (raw.squads[existingKey].isGuild) rejectGuildSquad(existingKey, 'add');

    const currentMembers = raw.squads[existingKey].members;
    const currentLower = new Set(currentMembers.map((m) => m.toLowerCase()));

    const added = [];
    const alreadyInSquad = [];
    const crossSquadWarnings = [];
    const newMembers = [...currentMembers];

    for (const name of normalizedNames) {
      const nameLower = name.toLowerCase();
      if (currentLower.has(nameLower)) {
        alreadyInSquad.push(name);
        continue;
      }

      const otherSquad = findPlayerCurrentSquad(raw, nameLower);
      if (otherSquad && otherSquad.toLowerCase() !== existingKey.toLowerCase()) {
        crossSquadWarnings.push({ name, otherSquad });
      }

      newMembers.push(name);
      currentLower.add(nameLower);
      added.push(name);
    }

    const squads = { ...raw.squads, [existingKey]: { isGuild: false, members: newMembers } };
    return { data: { ...raw, squads }, report: { key: existingKey, added, alreadyInSquad, crossSquadWarnings } };
  });
}

export async function removePlayer(guildId, squadKeyInput, playerNameInput) {
  const key = lookupKey(squadKeyInput);
  const nameLower = String(playerNameInput).trim().toLowerCase();

  return mutateSquadsConfig(guildId, (raw) => {
    const existingKey = findSquadKeyCaseInsensitive(raw, key);
    if (!existingKey) {
      throw new SquadCommandError('squadsError.notFound', { squad: squadKeyInput });
    }
    if (raw.squads[existingKey].isGuild) rejectGuildSquad(existingKey, 'remove');

    const currentMembers = raw.squads[existingKey].members;
    const index = currentMembers.findIndex((m) => m.toLowerCase() === nameLower);
    if (index === -1) {
      throw new SquadCommandError('squadsError.notInSquad', { player: playerNameInput, squad: existingKey });
    }

    const removedName = currentMembers[index];
    const newMembers = currentMembers.filter((_, i) => i !== index);
    const squads = { ...raw.squads, [existingKey]: { isGuild: false, members: newMembers } };
    return { data: { ...raw, squads }, report: { key: existingKey, removedName } };
  });
}

/**
 * Tipo y nombre actual de un squad, para que el comando pueda avisar ANTES de
 * renombrar un squad de gremio (renombrarlo cambia a qué gremio sigue).
 * @param {string} guildId
 * @param {string} squadKeyInput
 * @returns {Promise<{ key: string, isGuild: boolean }>}
 */
export async function describeSquad(guildId, squadKeyInput) {
  const key = lookupKey(squadKeyInput);
  const squad = (await loadConfig(guildId)).squads.get(key);
  if (!squad) throw new SquadCommandError('squadsError.notFound', { squad: squadKeyInput });
  return { key: squad.isGuild ? squad.guildName : key, isGuild: squad.isGuild };
}

export async function renameSquad(guildId, squadKeyInput, newKeyInput) {
  const oldKey = lookupKey(squadKeyInput);
  const current = await describeSquad(guildId, squadKeyInput).catch(() => null);
  // El tipo decide el formato del nombre nuevo; se vuelve a comprobar dentro
  // del candado por si el squad cambió entre medias.
  const newKey = current?.isGuild ? normalizeGuildSquadName(newKeyInput) : normalizeSquadKey(newKeyInput);
  if (current?.isGuild) await rejectIfMainGuild(guildId, newKey);

  return mutateSquadsConfig(guildId, (raw) => {
    const existingOldKey = findSquadKeyCaseInsensitive(raw, oldKey);
    if (!existingOldKey) {
      throw new SquadCommandError('squadsError.notFound', { squad: squadKeyInput });
    }
    const { isGuild } = raw.squads[existingOldKey];
    if (Boolean(current?.isGuild) !== isGuild) {
      throw new SquadCommandError('squadsError.changed', { squad: existingOldKey });
    }

    if (existingOldKey.toLowerCase() !== newKey.toLowerCase()) {
      const existingNewKey = findSquadKeyCaseInsensitive(raw, newKey.toLowerCase());
      if (existingNewKey) {
        throw new SquadCommandError('squadsError.existsAny', { squad: existingNewKey });
      }
    }

    const squads = {};
    for (const [k, squad] of Object.entries(raw.squads)) {
      squads[k === existingOldKey ? newKey : k] = squad;
    }

    return { data: { ...raw, squads }, report: { oldKey: existingOldKey, newKey, isGuild } };
  });
}

export async function movePlayer(guildId, playerNameInput, targetSquadKeyInput) {
  const nameLower = String(playerNameInput).trim().toLowerCase();
  const targetKey = lookupKey(targetSquadKeyInput);

  return mutateSquadsConfig(guildId, (raw) => {
    const existingTargetKey = findSquadKeyCaseInsensitive(raw, targetKey);
    if (!existingTargetKey) {
      throw new SquadCommandError('squadsError.notFound', { squad: targetSquadKeyInput });
    }
    if (raw.squads[existingTargetKey].isGuild) rejectGuildSquad(existingTargetKey, 'move');

    const fromKey = findPlayerCurrentSquad(raw, nameLower);
    if (!fromKey) {
      throw new SquadCommandError('squadsError.playerNoSquad', { player: playerNameInput });
    }
    if (fromKey.toLowerCase() === existingTargetKey.toLowerCase()) {
      throw new SquadCommandError('squadsError.alreadyIn', { player: playerNameInput, squad: existingTargetKey });
    }

    const originalName = raw.squads[fromKey].members.find((m) => m.toLowerCase() === nameLower);

    const squads = { ...raw.squads };
    squads[fromKey] = { isGuild: false, members: squads[fromKey].members.filter((m) => m.toLowerCase() !== nameLower) };
    squads[existingTargetKey] = { isGuild: false, members: [...squads[existingTargetKey].members, originalName] };

    return { data: { ...raw, squads }, report: { name: originalName, fromKey, toKey: existingTargetKey } };
  });
}
