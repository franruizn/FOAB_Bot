import { access, cp, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../dataPaths.js';
import { atomicWriteJson } from './fileStore.js';
import { GUILDS_DIR_NAME, ALBION_SERVERS, assertGuildId, defaultConfig, rutaEnCarpeta } from './guildStore.js';

// Migración única de la estructura vieja (un solo servidor, todo suelto en
// DATA_DIR) a la multiservidor:
//
//   DATA_DIR/squads.json, raffles.json, backups/
//     -> DATA_DIR/guilds/<GUILD_ID>/squads.json, raffles.json, backups/, config.json
//
// Todo se monta primero en DATA_DIR/guilds.migrando/ y solo al final se
// renombra a guilds/ (rename atómico). Si el proceso muere a mitad, guilds/
// no existe, los ficheros viejos siguen intactos y el siguiente arranque
// vuelve a empezar desde cero. Solo cuando guilds/ ya existe se borran los
// originales.

const STAGING_DIR_NAME = 'guilds.migrando';
const BACKUPS_DIR_NAME = 'backups';
const PRE_MIGRATION_PREFIX = 'pre-multiguild-';
const LOG_PREFIX = '[migración multiservidor]';

export class MigrationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MigrationError';
  }
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function envValue(env, name) {
  const value = (env[name] ?? '').trim();
  return value.length > 0 ? value : null;
}

/** Entradas de DATA_DIR/backups/ que son del bot viejo (no copias pre-migración). */
async function oldBackupEntries(dataDir) {
  try {
    const entries = await readdir(path.join(dataDir, BACKUPS_DIR_NAME));
    return entries.filter((name) => !name.startsWith(PRE_MIGRATION_PREFIX));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function readOldGuildNames(squadsPath, logger) {
  try {
    const raw = JSON.parse(await readFile(squadsPath, 'utf8'));
    if (!Array.isArray(raw?.guilds)) return [];
    return raw.guilds.filter((name) => typeof name === 'string' && name.trim().length > 0).map((name) => name.trim());
  } catch (error) {
    logger.warn(`${LOG_PREFIX} No se pudo leer la lista de gremios de ${squadsPath} (${error.message}): albionGuild queda vacío.`);
    return [];
  }
}

/**
 * Copia de seguridad completa de DATA_DIR antes de tocar nada, en
 * DATA_DIR/backups/pre-multiguild-<fecha>/. Deja fuera solo la propia carpeta
 * de staging y copias pre-migración anteriores.
 */
async function backupDataDir(dataDir, backupRoot, logger) {
  await mkdir(backupRoot, { recursive: true });
  for (const entry of await readdir(dataDir)) {
    if (entry === STAGING_DIR_NAME || entry === GUILDS_DIR_NAME) continue;
    if (entry === BACKUPS_DIR_NAME) {
      for (const sub of await oldBackupEntries(dataDir)) {
        await cp(path.join(dataDir, BACKUPS_DIR_NAME, sub), path.join(backupRoot, BACKUPS_DIR_NAME, sub), { recursive: true });
      }
      continue;
    }
    await cp(path.join(dataDir, entry), path.join(backupRoot, entry), { recursive: true });
  }
  logger.log(`${LOG_PREFIX} Copia de seguridad completa de DATA_DIR en ${backupRoot}.`);
}

/**
 * Ejecuta la migración si hace falta. Idempotente: si DATA_DIR/guilds/ ya
 * existe, no hace nada.
 *
 * @param {{ dataDir?: string, env?: Record<string, string | undefined>, logger?: Pick<Console, 'log' | 'warn'>, now?: Date }} [options]
 * @returns {Promise<{ estado: 'migrado' | 'ya-migrado' | 'nada-que-migrar', guildId?: string }>}
 * @throws {MigrationError} si hay datos viejos que migrar y GUILD_ID falta o no es válido
 */
export async function migrarAMultiguild({ dataDir = DATA_DIR, env = process.env, logger = console, now = new Date() } = {}) {
  const guildsDir = path.join(dataDir, GUILDS_DIR_NAME);
  const oldSquadsPath = path.join(dataDir, 'squads.json');
  const oldRafflesPath = path.join(dataDir, 'raffles.json');

  if (await exists(guildsDir)) {
    if (await exists(oldSquadsPath)) {
      logger.warn(
        `${LOG_PREFIX} ${guildsDir} ya existe, pero sigue habiendo un ${oldSquadsPath} de la estructura vieja. ` +
          'No se migra otra vez ni se usa: revísalo y bórralo a mano.',
      );
    }
    return { estado: 'ya-migrado' };
  }

  if (!(await exists(oldSquadsPath))) {
    return { estado: 'nada-que-migrar' };
  }

  // Mover los datos al servidor equivocado es peor que no arrancar: sin un
  // GUILD_ID explícito no se adivina nada.
  const guildId = envValue(env, 'GUILD_ID');
  if (!guildId) {
    throw new MigrationError(
      `${LOG_PREFIX} Hay datos de la estructura vieja (${oldSquadsPath}) pero falta GUILD_ID en el .env. ` +
        'Ponlo con el id del servidor de Discord al que pertenecen estos datos y vuelve a arrancar. No se ha movido nada.',
    );
  }
  try {
    assertGuildId(guildId);
  } catch {
    throw new MigrationError(`${LOG_PREFIX} GUILD_ID (${JSON.stringify(guildId)}) no es un id de servidor de Discord válido. No se ha movido nada.`);
  }

  logger.log(`${LOG_PREFIX} Estructura vieja detectada en ${dataDir}. Migrando al servidor ${guildId}...`);

  // 1. Copia de seguridad completa.
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  await backupDataDir(dataDir, path.join(dataDir, BACKUPS_DIR_NAME, `${PRE_MIGRATION_PREFIX}${stamp}`), logger);

  // 2. Carpeta del servidor, montada en staging.
  const stagingDir = path.join(dataDir, STAGING_DIR_NAME);
  await rm(stagingDir, { recursive: true, force: true }); // restos de un intento anterior cortado
  const stagedGuild = (fichero) => rutaEnCarpeta(stagingDir, guildId, fichero);
  await mkdir(stagedGuild(), { recursive: true });

  // 3. squads.json, raffles.json y backups/.
  await cp(oldSquadsPath, stagedGuild('squads.json'));
  logger.log(`${LOG_PREFIX} squads.json -> guilds/${guildId}/squads.json`);

  const hasRaffles = await exists(oldRafflesPath);
  if (hasRaffles) {
    await cp(oldRafflesPath, stagedGuild('raffles.json'));
    logger.log(`${LOG_PREFIX} raffles.json -> guilds/${guildId}/raffles.json`);
    try {
      const raffles = JSON.parse(await readFile(oldRafflesPath, 'utf8'));
      const foreign = Array.isArray(raffles) ? raffles.filter((r) => r?.guildId && r.guildId !== guildId) : [];
      if (foreign.length > 0) {
        logger.warn(
          `${LOG_PREFIX} ${foreign.length} sorteo(s) de raffles.json dicen pertenecer a otro servidor ` +
            `(${[...new Set(foreign.map((r) => r.guildId))].join(', ')}). Se han movido igualmente a ${guildId}: revísalos.`,
        );
      }
    } catch (error) {
      logger.warn(`${LOG_PREFIX} raffles.json no se pudo parsear (${error.message}). Se ha movido tal cual.`);
    }
  }

  const backupEntries = await oldBackupEntries(dataDir);
  for (const entry of backupEntries) {
    await cp(path.join(dataDir, BACKUPS_DIR_NAME, entry), path.join(stagedGuild('backups'), entry), { recursive: true });
  }
  if (backupEntries.length > 0) {
    logger.log(`${LOG_PREFIX} ${backupEntries.length} backup(s) -> guilds/${guildId}/backups/`);
  }

  // 4 y 5. config.json con lo que hoy está en el .env, y albionGuild = el
  // primer gremio de la lista vieja.
  const guildNames = await readOldGuildNames(oldSquadsPath, logger);
  const albionGuild = guildNames[0] ?? null;
  if (guildNames.length > 1) {
    logger.warn(
      `${LOG_PREFIX} squads.json tenía ${guildNames.length} gremios (${guildNames.join(', ')}). ` +
        `albionGuild = "${albionGuild}" (el primero). El resto (${guildNames.slice(1).join(', ')}) pasan a ser ` +
        'squads de tipo gremio automáticamente la primera vez que se cargue squads.json (ver services/config.js).',
    );
  }

  const rawServer = envValue(env, 'ALBION_SERVER');
  let albionServer = 'europe';
  if (rawServer && ALBION_SERVERS.has(rawServer)) {
    albionServer = rawServer;
  } else if (rawServer) {
    logger.warn(`${LOG_PREFIX} ALBION_SERVER="${rawServer}" no es válido (${[...ALBION_SERVERS].join(', ')}): se usa "europe".`);
  }

  const config = {
    ...defaultConfig(guildId),
    officerRoleId: envValue(env, 'OFFICER_ROLE_ID'),
    logChannelId: envValue(env, 'LOG_CHANNEL_ID'),
    raffleRoleId: envValue(env, 'RAFFLE_ROLE_ID'),
    dmOptoutRoleId: envValue(env, 'DM_OPTOUT_ROLE_ID'),
    albionServer,
    albionGuild,
    albionbbGuildId: envValue(env, 'ALBIONBB_GUILD_ID'),
    configuradoEn: now.toISOString(),
    configuradoPor: 'migración desde .env',
  };
  await atomicWriteJson(stagedGuild('config.json'), config);
  logger.log(`${LOG_PREFIX} config.json creado: ${JSON.stringify(config)}`);

  // Punto de no retorno: a partir de aquí la estructura nueva existe.
  await rename(stagingDir, guildsDir);

  await rm(oldSquadsPath, { force: true });
  if (hasRaffles) await rm(oldRafflesPath, { force: true });
  for (const entry of backupEntries) {
    await rm(path.join(dataDir, BACKUPS_DIR_NAME, entry), { recursive: true, force: true });
  }

  logger.log(
    `${LOG_PREFIX} Migración completada. Ya puedes quitar del .env OFFICER_ROLE_ID, LOG_CHANNEL_ID, RAFFLE_ROLE_ID, ` +
      'DM_OPTOUT_ROLE_ID, ALBION_SERVER y ALBIONBB_GUILD_ID: el bot ya no las lee.',
  );
  return { estado: 'migrado', guildId };
}
