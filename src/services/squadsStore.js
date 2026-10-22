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

const SQUAD_KEY_MAX_LENGTH = 32;

export class SquadCommandError extends Error {
  constructor(message) {
    super(message);
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
    throw new SquadCommandError(`La clave del squad debe tener entre 1 y ${SQUAD_KEY_MAX_LENGTH} caracteres.`);
  }
  for (const char of key) {
    const isLower = char >= 'a' && char <= 'z';
    const isDigit = char >= '0' && char <= '9';
    const isDash = char === '-';
    if (!isLower && !isDigit && !isDash) {
      throw new SquadCommandError(
        `La clave del squad "${key}" solo puede contener minúsculas (a-z), números y guiones. ` +
          'Si es un gremio de Albion, créalo con is-guild:true.',
      );
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
    throw new SquadCommandError(`El nombre del gremio debe tener entre 1 y ${MAX_GUILD_NAME_LENGTH} caracteres.`);
  }
  return name;
}

/** Clave para BUSCAR un squad existente (de cualquier tipo): sin validar formato. */
function lookupKey(input) {
  const key = String(input).trim().toLowerCase();
  if (key.length === 0) throw new SquadCommandError('Indica un squad.');
  return key;
}

function normalizePlayerName(input) {
  const name = String(input).trim();
  if (!isValidPlayerName(name)) {
    throw new SquadCommandError(
      `El nombre de jugador "${input}" debe tener entre ${MIN_NAME_LENGTH} y ${MAX_NAME_LENGTH} caracteres.`,
    );
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

function rejectGuildSquad(squadKey, action) {
  throw new SquadCommandError(
    `"${squadKey}" es un squad de gremio: sus miembros salen del gremio de Albion "${squadKey}" en cada batalla, ` +
      `no de una lista, así que no se puede ${action}. Para seguir a jugadores concretos, crea un squad de jugadores.`,
  );
}

function sameName(a, b) {
  return Boolean(a) && Boolean(b) && a.toLowerCase() === b.toLowerCase();
}

async function rejectIfMainGuild(guildId, guildName) {
  const { albionGuild } = await getConfig(guildId);
  if (sameName(albionGuild, guildName)) {
    throw new SquadCommandError(
      `"${guildName}" es el gremio principal de este servidor: ya cuenta como MAIN ZERG. Un squad de gremio con ` +
        'ese nombre duplicaría a todo el mundo.',
    );
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
      const kind = raw.squads[existing].isGuild ? 'de gremio' : 'de jugadores';
      throw new SquadCommandError(`Ya existe un squad ${kind} llamado "${existing}".`);
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
      throw new SquadCommandError(`El squad "${squadKeyInput}" no existe.`);
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
    throw new SquadCommandError('Debes indicar al menos un nombre de jugador.');
  }

  const normalizedNames = requestedNames.map(normalizePlayerName);

  return mutateSquadsConfig(guildId, (raw) => {
    const existingKey = findSquadKeyCaseInsensitive(raw, key);
    if (!existingKey) {
      throw new SquadCommandError(`El squad "${squadKeyInput}" no existe. Créalo antes con /squads create.`);
    }
    if (raw.squads[existingKey].isGuild) rejectGuildSquad(existingKey, 'añadirle jugadores a mano');

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
      throw new SquadCommandError(`El squad "${squadKeyInput}" no existe.`);
    }
    if (raw.squads[existingKey].isGuild) rejectGuildSquad(existingKey, 'quitarle jugadores a mano');

    const currentMembers = raw.squads[existingKey].members;
    const index = currentMembers.findIndex((m) => m.toLowerCase() === nameLower);
    if (index === -1) {
      throw new SquadCommandError(`"${playerNameInput}" no está en el squad "${existingKey}".`);
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
  if (!squad) throw new SquadCommandError(`El squad "${squadKeyInput}" no existe.`);
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
      throw new SquadCommandError(`El squad "${squadKeyInput}" no existe.`);
    }
    const { isGuild } = raw.squads[existingOldKey];
    if (Boolean(current?.isGuild) !== isGuild) {
      throw new SquadCommandError(`El squad "${existingOldKey}" cambió mientras tanto. Vuelve a intentarlo.`);
    }

    if (existingOldKey.toLowerCase() !== newKey.toLowerCase()) {
      const existingNewKey = findSquadKeyCaseInsensitive(raw, newKey.toLowerCase());
      if (existingNewKey) {
        throw new SquadCommandError(`Ya existe un squad llamado "${existingNewKey}".`);
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
      throw new SquadCommandError(`El squad "${targetSquadKeyInput}" no existe.`);
    }
    if (raw.squads[existingTargetKey].isGuild) rejectGuildSquad(existingTargetKey, 'mover jugadores a él');

    const fromKey = findPlayerCurrentSquad(raw, nameLower);
    if (!fromKey) {
      throw new SquadCommandError(`"${playerNameInput}" no está en ningún squad. Usa /squads add para añadirlo.`);
    }
    if (fromKey.toLowerCase() === existingTargetKey.toLowerCase()) {
      throw new SquadCommandError(`"${playerNameInput}" ya está en "${existingTargetKey}".`);
    }

    const originalName = raw.squads[fromKey].members.find((m) => m.toLowerCase() === nameLower);

    const squads = { ...raw.squads };
    squads[fromKey] = { isGuild: false, members: squads[fromKey].members.filter((m) => m.toLowerCase() !== nameLower) };
    squads[existingTargetKey] = { isGuild: false, members: [...squads[existingTargetKey].members, originalName] };

    return { data: { ...raw, squads }, report: { name: originalName, fromKey, toKey: existingTargetKey } };
  });
}
