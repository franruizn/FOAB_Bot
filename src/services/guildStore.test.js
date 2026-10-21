import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// DATA_DIR se lee al importar dataPaths.js: tiene que estar fijado antes.
const DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'guild-store-test-'));
process.env.DATA_DIR = DATA_DIR;

const { getConfig, setConfig, estaConfigurado, rutaDe, listarGuilds, defaultConfig, GuildConfigError } = await import('./guildStore.js');
const { withFileLock } = await import('./fileStore.js');
const { loadConfig } = await import('./config.js');
const { addRaffle, loadRaffles } = await import('./rafflesStore.js');
const { createSquad } = await import('./squadsStore.js');

const GUILD_A = '100000000000000001';
const GUILD_B = '100000000000000002';
let nextGuild = 3n;
const freshGuild = () => String(100000000000000000n + nextGuild++);

after(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
});

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function snapshotDir(dir) {
  const result = {};
  for (const name of (await readdir(dir)).sort()) {
    if (name === 'backups') continue;
    result[name] = await readFile(path.join(dir, name), 'utf8');
  }
  return result;
}

test('getConfig(): un servidor nuevo devuelve los valores por defecto y crea el fichero', async () => {
  const guildId = freshGuild();

  const config = await getConfig(guildId);

  assert.deepEqual(config, defaultConfig(guildId));
  assert.equal(config.version, 1);
  assert.equal(config.activo, true);
  assert.equal(config.albionServer, 'europe');
  assert.equal(config.officerRoleId, null);
  assert.deepEqual(await readJson(rutaDe(guildId, 'config.json')), defaultConfig(guildId), 'debe quedar escrito en disco');
  assert.equal(await estaConfigurado(guildId), false);
});

test('getConfig(): devuelve una copia, mutarla no toca la caché', async () => {
  const guildId = freshGuild();
  const config = await getConfig(guildId);
  config.officerRoleId = 'mutado-a-mano';
  assert.equal((await getConfig(guildId)).officerRoleId, null);
});

test('setConfig(): guarda los cambios y estaConfigurado() lo refleja', async () => {
  const guildId = freshGuild();
  const next = await setConfig(guildId, { officerRoleId: 'oficiales', configuradoEn: '2026-10-22T10:00:00.000Z', configuradoPor: '1' });

  assert.equal(next.officerRoleId, 'oficiales');
  assert.equal((await readJson(rutaDe(guildId, 'config.json'))).officerRoleId, 'oficiales');
  assert.equal(await estaConfigurado(guildId), true);
});

test('setConfig(): rechaza campos desconocidos, protegidos o con valores inválidos', async () => {
  const guildId = freshGuild();
  await assert.rejects(() => setConfig(guildId, { noExiste: 'x' }), GuildConfigError);
  await assert.rejects(() => setConfig(guildId, { guildId: GUILD_B }), GuildConfigError);
  await assert.rejects(() => setConfig(guildId, { version: 2 }), GuildConfigError);
  await assert.rejects(() => setConfig(guildId, { albionServer: 'marte' }), GuildConfigError);
  await assert.rejects(() => setConfig(guildId, { activo: 'si' }), GuildConfigError);
});

test('rutaDe(): un guildId que no es un snowflake o un fichero con ruta nunca llegan al disco', () => {
  assert.throws(() => rutaDe('../otro', 'config.json'), GuildConfigError);
  assert.throws(() => rutaDe('guild-1', 'config.json'), GuildConfigError);
  assert.throws(() => rutaDe(undefined, 'config.json'), GuildConfigError);
  assert.throws(() => rutaDe(GUILD_A, '../config.json'), GuildConfigError);
  assert.throws(() => rutaDe(GUILD_A, 'sub/config.json'), GuildConfigError);
  assert.equal(rutaDe(GUILD_A, 'squads.json'), path.join(DATA_DIR, 'guilds', GUILD_A, 'squads.json'));
});

test('escribir en el servidor A no toca los ficheros del B', async () => {
  await setConfig(GUILD_B, { officerRoleId: 'oficiales-b' });
  await writeFile(rutaDe(GUILD_B, 'squads.json'), JSON.stringify({ squads: { b: { isGuild: false, members: ['jugadorb'] } } }));
  await addRaffle({ id: 'r-b', guildId: GUILD_B, channelId: 'c', messageId: 'm', endsAt: 0, creatorId: 'u' });
  const before = await snapshotDir(rutaDe(GUILD_B));

  await setConfig(GUILD_A, { officerRoleId: 'oficiales-a', logChannelId: 'logs-a' });
  await writeFile(rutaDe(GUILD_A, 'squads.json'), JSON.stringify({ squads: {} }));
  await createSquad(GUILD_A, 'nuevo');
  await addRaffle({ id: 'r-a', guildId: GUILD_A, channelId: 'c', messageId: 'm', endsAt: 0, creatorId: 'u' });

  assert.deepEqual(await snapshotDir(rutaDe(GUILD_B)), before, 'ningún fichero del servidor B debe cambiar');
  assert.equal((await getConfig(GUILD_B)).officerRoleId, 'oficiales-b');
  assert.deepEqual((await loadRaffles(GUILD_B)).map((r) => r.id), ['r-b']);
  assert.deepEqual((await loadRaffles(GUILD_A)).map((r) => r.id), ['r-a']);
});

test('la caché devuelve datos distintos para guildId distintos (config y squads)', async () => {
  const g1 = freshGuild();
  const g2 = freshGuild();
  await setConfig(g1, { officerRoleId: 'rol-1' });
  await setConfig(g2, { officerRoleId: 'rol-2' });
  await mkdir(rutaDe(g1), { recursive: true });
  await writeFile(rutaDe(g1, 'squads.json'), JSON.stringify({ squads: { alfa: { isGuild: false, members: ['jugadoruno'] }, Uno: { isGuild: true, members: [] } } }));
  await writeFile(rutaDe(g2, 'squads.json'), JSON.stringify({ squads: { beta: { isGuild: false, members: ['jugadordos'] }, Dos: { isGuild: true, members: [] } } }));

  // Dos vueltas: la segunda sale de la caché, y aun así no se cruzan.
  for (let i = 0; i < 2; i++) {
    assert.equal((await getConfig(g1)).officerRoleId, 'rol-1');
    assert.equal((await getConfig(g2)).officerRoleId, 'rol-2');
    assert.deepEqual([...(await loadConfig(g1)).guildToSquad.keys()], ['uno']);
    assert.deepEqual([...(await loadConfig(g2)).guildToSquad.keys()], ['dos']);
    assert.deepEqual((await loadConfig(g1)).squadOrder, ['alfa', 'uno']);
    assert.deepEqual((await loadConfig(g2)).squadOrder, ['beta', 'dos']);
  }
});

test('dos escrituras concurrentes en servidores distintos no se bloquean entre sí', async () => {
  const g1 = freshGuild();
  const g2 = freshGuild();
  await getConfig(g1);
  await getConfig(g2);

  // Candado del config.json de g1 retenido hasta que el test lo suelte.
  let release;
  const held = withFileLock(rutaDe(g1, 'config.json'), () => new Promise((resolve) => (release = resolve)));

  let g1Done = false;
  const g1Write = setConfig(g1, { officerRoleId: 'espera' }).then(() => (g1Done = true));

  // La de g2 termina aunque g1 siga bloqueado.
  const g2Result = await Promise.race([
    setConfig(g2, { officerRoleId: 'libre' }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('g2 se quedó esperando al candado de g1')), 1000)),
  ]);
  assert.equal(g2Result.officerRoleId, 'libre');
  assert.equal(g1Done, false, 'la escritura de g1 sí debe esperar a su propio candado');

  release();
  await held;
  await g1Write;
  assert.equal((await getConfig(g1)).officerRoleId, 'espera');
});

test('escrituras concurrentes en el MISMO servidor se serializan sin perder cambios', async () => {
  const guildId = freshGuild();
  await Promise.all([
    setConfig(guildId, { officerRoleId: 'a' }),
    setConfig(guildId, { logChannelId: 'b' }),
    setConfig(guildId, { raffleRoleId: 'c' }),
  ]);
  const config = await getConfig(guildId);
  assert.deepEqual([config.officerRoleId, config.logChannelId, config.raffleRoleId], ['a', 'b', 'c']);
});

test('listarGuilds(): solo carpetas con id de servidor válido', async () => {
  await mkdir(path.join(DATA_DIR, 'guilds', 'no-es-un-id'), { recursive: true });
  const ids = await listarGuilds();
  assert.ok(ids.includes(GUILD_A) && ids.includes(GUILD_B));
  assert.ok(!ids.includes('no-es-un-id'));
});
