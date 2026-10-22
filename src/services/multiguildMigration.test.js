import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { migrarAMultiguild, MigrationError } from './multiguildMigration.js';

const GUILD_ID = '1514278667612717138';
const NOW = new Date('2026-10-22T10:00:00.000Z');
const tempDirs = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function makeLogger() {
  const logs = [];
  const warns = [];
  return { log: (msg) => logs.push(msg), warn: (msg) => warns.push(msg), logs, warns };
}

const OLD_ENV = {
  GUILD_ID,
  OFFICER_ROLE_ID: 'officer-role',
  LOG_CHANNEL_ID: 'log-channel',
  RAFFLE_ROLE_ID: 'raffle-role',
  DM_OPTOUT_ROLE_ID: 'optout-role',
  ALBION_SERVER: 'americas',
  ALBIONBB_GUILD_ID: 'albionbb-123',
};

/** DATA_DIR con la estructura vieja de un solo servidor. */
async function makeOldDataDir({ guilds = ['vips'] } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'multiguild-migration-test-'));
  tempDirs.push(dataDir);
  await writeFile(path.join(dataDir, 'squads.json'), JSON.stringify({ guilds, squads: { foab: ['fokinfran'] } }));
  await writeFile(path.join(dataDir, 'raffles.json'), JSON.stringify([{ id: 'r1', guildId: GUILD_ID, channelId: 'c', messageId: 'm', endsAt: 1, creatorId: 'u' }]));
  await writeFile(path.join(dataDir, 'dm.json'), JSON.stringify({ lastStartedAt: 5, inProgress: null }));
  await mkdir(path.join(dataDir, 'backups'));
  await writeFile(path.join(dataDir, 'backups', 'squads-2026-01-01T00-00-00-000Z.json'), '{"viejo":1}');
  await writeFile(path.join(dataDir, 'backups', 'squads-2026-01-02T00-00-00-000Z.json'), '{"viejo":2}');
  return dataDir;
}

test('migración: mueve squads.json, raffles.json y backups/ al servidor y crea su config.json desde el .env', async () => {
  const dataDir = await makeOldDataDir();
  const originalSquads = await readFile(path.join(dataDir, 'squads.json'), 'utf8');
  const originalRaffles = await readFile(path.join(dataDir, 'raffles.json'), 'utf8');
  const logger = makeLogger();

  const result = await migrarAMultiguild({ dataDir, env: OLD_ENV, logger, now: NOW });

  assert.deepEqual(result, { estado: 'migrado', guildId: GUILD_ID });
  const guildDir = path.join(dataDir, 'guilds', GUILD_ID);

  assert.equal(await readFile(path.join(guildDir, 'squads.json'), 'utf8'), originalSquads);
  assert.equal(await readFile(path.join(guildDir, 'raffles.json'), 'utf8'), originalRaffles);
  assert.deepEqual((await readdir(path.join(guildDir, 'backups'))).sort(), [
    'squads-2026-01-01T00-00-00-000Z.json',
    'squads-2026-01-02T00-00-00-000Z.json',
  ]);

  const config = JSON.parse(await readFile(path.join(guildDir, 'config.json'), 'utf8'));
  assert.deepEqual(config, {
    version: 1,
    guildId: GUILD_ID,
    nombre: null,
    activo: true,
    inactivoDesde: null,
    officerRoleId: 'officer-role',
    logChannelId: 'log-channel',
    raffleRoleId: 'raffle-role',
    dmOptoutRoleId: 'optout-role',
    albionServer: 'americas',
    albionGuild: 'vips',
    albionbbGuildId: 'albionbb-123',
    // Lo fija el arranque (reconcileGuilds) con el preferredLocale del servidor.
    idioma: null,
    configuradoEn: NOW.toISOString(),
    configuradoPor: 'migración desde .env',
  });

  // Los originales ya no están en la raíz (movidos, no copiados)...
  assert.equal(await exists(path.join(dataDir, 'squads.json')), false);
  assert.equal(await exists(path.join(dataDir, 'raffles.json')), false);
  assert.equal(await exists(path.join(dataDir, 'guilds.migrando')), false, 'no deben quedar restos del staging');
  // ...dm.json es del bot y se queda donde estaba...
  assert.equal(await exists(path.join(dataDir, 'dm.json')), true);
  // ...y en DATA_DIR/backups/ solo queda la copia pre-migración, completa.
  const rootBackups = await readdir(path.join(dataDir, 'backups'));
  assert.deepEqual(rootBackups, ['pre-multiguild-2026-10-22T10-00-00-000Z']);
  const preDir = path.join(dataDir, 'backups', rootBackups[0]);
  assert.equal(await readFile(path.join(preDir, 'squads.json'), 'utf8'), originalSquads);
  assert.equal(await readFile(path.join(preDir, 'raffles.json'), 'utf8'), originalRaffles);
  assert.equal(await exists(path.join(preDir, 'dm.json')), true);
  assert.equal(await exists(path.join(preDir, 'backups', 'squads-2026-01-01T00-00-00-000Z.json')), true);

  assert.ok(logger.logs.some((msg) => msg.includes('Migración completada')), 'debe dejar constancia en el log');
  assert.deepEqual(logger.warns, [], 'con un solo gremio no hay nada que avisar');
});

test('migración: es idempotente, repetirla no cambia nada', async () => {
  const dataDir = await makeOldDataDir();
  await migrarAMultiguild({ dataDir, env: OLD_ENV, logger: makeLogger(), now: NOW });
  const guildDir = path.join(dataDir, 'guilds', GUILD_ID);
  const configBefore = await readFile(path.join(guildDir, 'config.json'), 'utf8');
  const rootBefore = (await readdir(dataDir)).sort();
  const backupsBefore = (await readdir(path.join(dataDir, 'backups'))).sort();

  const second = await migrarAMultiguild({ dataDir, env: OLD_ENV, logger: makeLogger(), now: new Date('2026-10-23T00:00:00.000Z') });

  assert.deepEqual(second, { estado: 'ya-migrado' });
  assert.equal(await readFile(path.join(guildDir, 'config.json'), 'utf8'), configBefore);
  assert.deepEqual((await readdir(dataDir)).sort(), rootBefore);
  assert.deepEqual((await readdir(path.join(dataDir, 'backups'))).sort(), backupsBefore, 'no debe hacer otro backup');
});

test('migración: con dos gremios en la config vieja, avisa y conserva el primero', async () => {
  const dataDir = await makeOldDataDir({ guilds: ['VIPS', 'Otro Gremio'] });
  const logger = makeLogger();

  await migrarAMultiguild({ dataDir, env: OLD_ENV, logger, now: NOW });

  const guildDir = path.join(dataDir, 'guilds', GUILD_ID);
  const config = JSON.parse(await readFile(path.join(guildDir, 'config.json'), 'utf8'));
  assert.equal(config.albionGuild, 'VIPS');

  assert.equal(logger.warns.length, 1);
  assert.match(logger.warns[0], /"VIPS"/, 'debe decir cuál ha tomado');
  assert.match(logger.warns[0], /Otro Gremio/, 'debe nombrar los que no ha tomado');
  assert.match(logger.warns[0], /squads de tipo gremio/);

  // Nada se descarta en silencio: el segundo gremio sigue en squads.json.
  const squads = JSON.parse(await readFile(path.join(guildDir, 'squads.json'), 'utf8'));
  assert.deepEqual(squads.guilds, ['VIPS', 'Otro Gremio']);
});

test('migración: sin GUILD_ID no mueve nada y lanza (el bot no arranca)', async () => {
  const dataDir = await makeOldDataDir();
  const rootBefore = (await readdir(dataDir)).sort();
  const squadsBefore = await readFile(path.join(dataDir, 'squads.json'), 'utf8');
  const { GUILD_ID: _omitted, ...envSinGuild } = OLD_ENV;

  await assert.rejects(
    () => migrarAMultiguild({ dataDir, env: envSinGuild, logger: makeLogger(), now: NOW }),
    (error) => error instanceof MigrationError && /GUILD_ID/.test(error.message),
  );

  assert.deepEqual((await readdir(dataDir)).sort(), rootBefore, 'no debe crear guilds/ ni ningún backup');
  assert.equal(await readFile(path.join(dataDir, 'squads.json'), 'utf8'), squadsBefore);
  assert.deepEqual((await readdir(path.join(dataDir, 'backups'))).sort(), [
    'squads-2026-01-01T00-00-00-000Z.json',
    'squads-2026-01-02T00-00-00-000Z.json',
  ]);
});

test('migración: un GUILD_ID que no es un id de Discord tampoco mueve nada', async () => {
  const dataDir = await makeOldDataDir();
  const rootBefore = (await readdir(dataDir)).sort();

  await assert.rejects(() => migrarAMultiguild({ dataDir, env: { ...OLD_ENV, GUILD_ID: '../otro' }, logger: makeLogger(), now: NOW }), MigrationError);

  assert.deepEqual((await readdir(dataDir)).sort(), rootBefore);
});

test('migración: un intento anterior cortado a mitad (staging sin renombrar) se rehace desde cero', async () => {
  const dataDir = await makeOldDataDir();
  await mkdir(path.join(dataDir, 'guilds.migrando', GUILD_ID), { recursive: true });
  await writeFile(path.join(dataDir, 'guilds.migrando', GUILD_ID, 'basura.json'), '{}');

  const result = await migrarAMultiguild({ dataDir, env: OLD_ENV, logger: makeLogger(), now: NOW });

  assert.equal(result.estado, 'migrado');
  const guildFiles = (await readdir(path.join(dataDir, 'guilds', GUILD_ID))).sort();
  assert.deepEqual(guildFiles, ['backups', 'config.json', 'raffles.json', 'squads.json']);
});

test('sin datos viejos (DATA_DIR vacío) no hace nada, ni exige GUILD_ID', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'multiguild-migration-test-'));
  tempDirs.push(dataDir);

  const result = await migrarAMultiguild({ dataDir, env: {}, logger: makeLogger(), now: NOW });

  assert.deepEqual(result, { estado: 'nada-que-migrar' });
  assert.deepEqual(await readdir(dataDir), []);
});
