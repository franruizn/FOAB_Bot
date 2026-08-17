import { readFile, writeFile, rename, mkdir, readdir, unlink, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeConfig, invalidateConfigCache, isValidPlayerName, MIN_NAME_LENGTH, MAX_NAME_LENGTH } from './config.js';

const BACKUP_DIR_NAME = 'backups';
const MAX_BACKUPS = 10;
const SQUAD_KEY_MAX_LENGTH = 32;

export class SquadCommandError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SquadCommandError';
  }
}

// --- mutex de escritura: una cadena de promesas serializa todas las mutaciones ---

let writeTail = Promise.resolve();

function withWriteLock(task) {
  const run = writeTail.then(task, task);
  writeTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Devuelve una promesa que se resuelve cuando termina la última escritura
 * encolada en este momento (éxito o fallo). Pensado para el shutdown por
 * SIGTERM: esperar esto antes de salir evita cortar un fs.rename() a mitad.
 * No espera escrituras que se encolen DESPUÉS de llamarlo.
 * @returns {Promise<void>}
 */
export function waitForPendingWrites() {
  return writeTail;
}

// --- validación de entrada de usuario ---

/**
 * Normaliza y valida una clave de squad: minúsculas, a-z/0-9/guiones, máx 32.
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
      throw new SquadCommandError(`La clave del squad "${key}" solo puede contener minúsculas (a-z), números y guiones.`);
    }
  }
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
  for (const [squadKey, members] of Object.entries(raw.squads)) {
    if (members.some((m) => m.toLowerCase() === nameLower)) return squadKey;
  }
  return null;
}

// --- lectura / escritura del fichero ---

async function readRawConfig(filePath) {
  const content = await readFile(filePath, 'utf8');
  return JSON.parse(content);
}

async function backupCurrentFile(filePath) {
  const backupDir = path.join(path.dirname(filePath), BACKUP_DIR_NAME);
  await mkdir(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  await copyFile(filePath, path.join(backupDir, `squads-${timestamp}.json`));

  const entries = (await readdir(backupDir))
    .filter((name) => name.startsWith('squads-') && name.endsWith('.json'))
    .sort(); // timestamps ISO -> orden lexicográfico == orden cronológico

  const excess = entries.length - MAX_BACKUPS;
  for (let i = 0; i < excess; i++) {
    await unlink(path.join(backupDir, entries[i]));
  }
}

async function atomicWrite(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmpPath, filePath);
}

/**
 * Aplica una mutación al fichero de squads de forma segura:
 * 1. serializa con las demás escrituras concurrentes (mutex),
 * 2. lee el fichero actual del disco (nunca de la caché de config.js),
 * 3. ejecuta mutateFn sobre una copia y valida el resultado con el mismo
 *    validador que usa loadConfig ANTES de tocar nada en disco,
 * 4. hace backup del fichero actual y solo entonces escribe atómicamente
 *    (tmp + rename), conservando las últimas 10 copias,
 * 5. invalida la caché de loadConfig.
 *
 * @param {string} filePath
 * @param {(raw: {guilds: string[], squads: Record<string, string[]>}) => { data: object, report: object }} mutateFn
 * @returns {Promise<{ data: object, report: object }>}
 */
export async function mutateSquadsConfig(filePath, mutateFn) {
  return withWriteLock(async () => {
    const raw = await readRawConfig(filePath);
    const { data, report } = mutateFn(structuredClone(raw));

    // Si esto lanza (ConfigError), no se toca el fichero original.
    normalizeConfig(data, filePath);

    await backupCurrentFile(filePath);
    await atomicWrite(filePath, data);
    invalidateConfigCache();

    return { data, report };
  });
}

// --- mutaciones de alto nivel ---

export async function createSquad(filePath, squadKeyInput) {
  const key = normalizeSquadKey(squadKeyInput);
  return mutateSquadsConfig(filePath, (raw) => {
    if (findSquadKeyCaseInsensitive(raw, key)) {
      throw new SquadCommandError(`El squad "${key}" ya existe.`);
    }
    return { data: { ...raw, squads: { ...raw.squads, [key]: [] } }, report: { key } };
  });
}

export async function deleteSquad(filePath, squadKeyInput) {
  const key = normalizeSquadKey(squadKeyInput);
  return mutateSquadsConfig(filePath, (raw) => {
    const existingKey = findSquadKeyCaseInsensitive(raw, key);
    if (!existingKey) {
      throw new SquadCommandError(`El squad "${key}" no existe.`);
    }
    const removedMembers = raw.squads[existingKey];
    const squads = { ...raw.squads };
    delete squads[existingKey];
    return { data: { ...raw, squads }, report: { key: existingKey, removedMembers } };
  });
}

export async function addPlayers(filePath, squadKeyInput, playerNamesInput) {
  const key = normalizeSquadKey(squadKeyInput);
  const requestedNames = String(playerNamesInput)
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  if (requestedNames.length === 0) {
    throw new SquadCommandError('Debes indicar al menos un nombre de jugador.');
  }

  const normalizedNames = requestedNames.map(normalizePlayerName);

  return mutateSquadsConfig(filePath, (raw) => {
    const existingKey = findSquadKeyCaseInsensitive(raw, key);
    if (!existingKey) {
      throw new SquadCommandError(`El squad "${key}" no existe. Créalo antes con /squads create.`);
    }

    const currentMembers = raw.squads[existingKey];
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

    const squads = { ...raw.squads, [existingKey]: newMembers };
    return { data: { ...raw, squads }, report: { key: existingKey, added, alreadyInSquad, crossSquadWarnings } };
  });
}

export async function removePlayer(filePath, squadKeyInput, playerNameInput) {
  const key = normalizeSquadKey(squadKeyInput);
  const nameLower = String(playerNameInput).trim().toLowerCase();

  return mutateSquadsConfig(filePath, (raw) => {
    const existingKey = findSquadKeyCaseInsensitive(raw, key);
    if (!existingKey) {
      throw new SquadCommandError(`El squad "${key}" no existe.`);
    }

    const currentMembers = raw.squads[existingKey];
    const index = currentMembers.findIndex((m) => m.toLowerCase() === nameLower);
    if (index === -1) {
      throw new SquadCommandError(`"${playerNameInput}" no está en el squad "${existingKey}".`);
    }

    const removedName = currentMembers[index];
    const newMembers = currentMembers.filter((_, i) => i !== index);
    const squads = { ...raw.squads, [existingKey]: newMembers };
    return { data: { ...raw, squads }, report: { key: existingKey, removedName } };
  });
}

export async function renameSquad(filePath, squadKeyInput, newKeyInput) {
  const oldKeyNormalized = normalizeSquadKey(squadKeyInput);
  const newKey = normalizeSquadKey(newKeyInput);

  return mutateSquadsConfig(filePath, (raw) => {
    const existingOldKey = findSquadKeyCaseInsensitive(raw, oldKeyNormalized);
    if (!existingOldKey) {
      throw new SquadCommandError(`El squad "${oldKeyNormalized}" no existe.`);
    }

    if (existingOldKey.toLowerCase() !== newKey) {
      const existingNewKey = findSquadKeyCaseInsensitive(raw, newKey);
      if (existingNewKey) {
        throw new SquadCommandError(`Ya existe un squad llamado "${newKey}".`);
      }
    }

    const squads = {};
    for (const [k, members] of Object.entries(raw.squads)) {
      squads[k === existingOldKey ? newKey : k] = members;
    }

    return { data: { ...raw, squads }, report: { oldKey: existingOldKey, newKey } };
  });
}

export async function movePlayer(filePath, playerNameInput, targetSquadKeyInput) {
  const nameLower = String(playerNameInput).trim().toLowerCase();
  const targetKey = normalizeSquadKey(targetSquadKeyInput);

  return mutateSquadsConfig(filePath, (raw) => {
    const existingTargetKey = findSquadKeyCaseInsensitive(raw, targetKey);
    if (!existingTargetKey) {
      throw new SquadCommandError(`El squad "${targetKey}" no existe.`);
    }

    const fromKey = findPlayerCurrentSquad(raw, nameLower);
    if (!fromKey) {
      throw new SquadCommandError(`"${playerNameInput}" no está en ningún squad. Usa /squads add para añadirlo.`);
    }
    if (fromKey.toLowerCase() === existingTargetKey.toLowerCase()) {
      throw new SquadCommandError(`"${playerNameInput}" ya está en "${existingTargetKey}".`);
    }

    const originalName = raw.squads[fromKey].find((m) => m.toLowerCase() === nameLower);

    const squads = { ...raw.squads };
    squads[fromKey] = squads[fromKey].filter((m) => m.toLowerCase() !== nameLower);
    squads[existingTargetKey] = [...squads[existingTargetKey], originalName];

    return { data: { ...raw, squads }, report: { name: originalName, fromKey, toKey: existingTargetKey } };
  });
}

export async function addGuild(filePath, guildNameInput) {
  const name = String(guildNameInput).trim();
  if (name.length === 0) {
    throw new SquadCommandError('El nombre del gremio no puede estar vacío.');
  }
  const nameLower = name.toLowerCase();

  return mutateSquadsConfig(filePath, (raw) => {
    if (raw.guilds.some((g) => g.toLowerCase() === nameLower)) {
      throw new SquadCommandError(`"${name}" ya está en la lista de gremios.`);
    }
    return { data: { ...raw, guilds: [...raw.guilds, name] }, report: { name } };
  });
}

export async function removeGuild(filePath, guildNameInput) {
  const nameLower = String(guildNameInput).trim().toLowerCase();

  return mutateSquadsConfig(filePath, (raw) => {
    const index = raw.guilds.findIndex((g) => g.toLowerCase() === nameLower);
    if (index === -1) {
      throw new SquadCommandError(`"${guildNameInput}" no está en la lista de gremios.`);
    }
    const removedName = raw.guilds[index];
    const guilds = raw.guilds.filter((_, i) => i !== index);
    // Si guilds queda vacío, normalizeConfig lo rechaza dentro de
    // mutateSquadsConfig (ConfigError) y no se escribe nada.
    return { data: { ...raw, guilds }, report: { name: removedName } };
  });
}
