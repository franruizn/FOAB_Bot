import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// DATA_DIR se lee al importar dataPaths.js: tiene que estar fijado antes.
const DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'squads-format-test-'));
process.env.DATA_DIR = DATA_DIR;

const { normalizeConfig, migrateLegacySquads, loadConfig, ConfigError } = await import('./config.js');
const { rutaDe, setConfig, getConfig } = await import('./guildStore.js');
const {
  createSquad,
  addPlayers,
  removePlayer,
  movePlayer,
  renameSquad,
  deleteSquad,
  SquadCommandError,
} = await import('./squadsStore.js');

after(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
});

let nextGuild = 1n;
const freshGuild = () => String(300000000000000000n + nextGuild++);

/** Servidor con gremio principal "FOAB" y el squads.json dado. */
async function makeGuild(squadsJson, { albionGuild = 'FOAB' } = {}) {
  const guildId = freshGuild();
  await setConfig(guildId, { albionGuild });
  await mkdir(rutaDe(guildId), { recursive: true });
  await writeFile(rutaDe(guildId, 'squads.json'), JSON.stringify(squadsJson));
  return guildId;
}

async function readSquadsFile(guildId) {
  return JSON.parse(await readFile(rutaDe(guildId, 'squads.json'), 'utf8'));
}

// --- formato ---

test('formato: isGuild es obligatorio y explícito', () => {
  assert.throws(() => normalizeConfig({ squads: { foab: { members: [] } } }, 'x'), ConfigError);
  assert.throws(() => normalizeConfig({ squads: { foab: { isGuild: 'no', members: [] } } }, 'x'), ConfigError);
  assert.throws(() => normalizeConfig({ squads: { foab: ['a'] } }, 'x'), ConfigError, 'el formato viejo no pasa el validador nuevo');
});

test('formato: un squad de jugadores sin miembros sigue siendo de jugadores', () => {
  const config = normalizeConfig({ squads: { nuevo: { isGuild: false, members: [] } } }, 'x');
  assert.equal(config.squads.get('nuevo').isGuild, false);
  assert.equal(config.guildToSquad.size, 0);
});

test('formato: el nombre de un squad de gremio es el gremio, con su casing y espacios', () => {
  const config = normalizeConfig({ squads: { 'Los Bombas': { isGuild: true, members: [] } } }, 'x');
  const squad = config.squads.get('los bombas');
  assert.deepEqual({ display: squad.display, guildName: squad.guildName, isGuild: squad.isGuild }, {
    display: 'Los Bombas',
    guildName: 'Los Bombas',
    isGuild: true,
  });
  assert.equal(config.guildToSquad.get('los bombas'), 'los bombas');
});

test('formato: members de un squad de gremio se ignora, con aviso', () => {
  const config = normalizeConfig({ squads: { Dementia: { isGuild: true, members: ['alguien'] } } }, 'x');
  assert.equal(config.squads.get('dementia').members.size, 0);
  assert.equal(config.playerToSquad.size, 0);
  assert.match(config.warnings[0], /se ignoran/);
});

// --- migración del formato viejo ---

test('migración: cada squad de array pasa a { isGuild: false, members } sin perder a nadie', () => {
  const legacy = { guilds: ['FOAB'], squads: { foab: ['FokinFran', 'DanyHM'], heal: ['Healer1'], vacio: [] } };
  const { data } = migrateLegacySquads(legacy, { mainGuild: 'FOAB' });

  assert.deepEqual(data, {
    squads: {
      foab: { isGuild: false, members: ['FokinFran', 'DanyHM'] },
      heal: { isGuild: false, members: ['Healer1'] },
      vacio: { isGuild: false, members: [] },
    },
  });
  assert.doesNotThrow(() => normalizeConfig(data, 'x'));
});

test('migración: los gremios viejos que no son el principal pasan a squads de gremio', () => {
  const legacy = { guilds: ['FOAB', 'Dementia', 'Los Bombas'], squads: { foab: ['FokinFran'] } };
  const { data, mainGuild } = migrateLegacySquads(legacy, { mainGuild: 'foab' });

  assert.equal(mainGuild, 'foab');
  assert.deepEqual(Object.keys(data.squads), ['foab', 'Dementia', 'Los Bombas']);
  assert.deepEqual(data.squads.Dementia, { isGuild: true, members: [] });
  assert.equal(data.squads.foab.isGuild, false, 'el squad de jugadores "foab" no se confunde con el gremio principal');
});

test('migración: un gremio viejo que choca con un squad de jugadores no se convierte en silencio', () => {
  const legacy = { guilds: ['FOAB', 'raf'], squads: { raf: ['a1b'] } };
  assert.throws(() => migrateLegacySquads(legacy, { mainGuild: 'FOAB' }), (error) => error.reason === 'migration_conflict');
});

test('migración: loadConfig convierte el fichero una vez, con backup, y luego lo lee en el formato nuevo', async () => {
  const legacy = { guilds: ['FOAB', 'Dementia'], squads: { foab: ['FokinFran', 'DanyHM'] } };
  const guildId = await makeGuild(legacy);

  const config = await loadConfig(guildId);

  // Clave en minúsculas para comparar, nombre original para mostrar.
  assert.deepEqual(
    [...config.squads.get('foab').members],
    [
      ['fokinfran', 'FokinFran'],
      ['danyhm', 'DanyHM'],
    ],
  );
  assert.equal(config.squads.get('dementia').isGuild, true);
  assert.deepEqual(await readSquadsFile(guildId), {
    squads: {
      foab: { isGuild: false, members: ['FokinFran', 'DanyHM'] },
      Dementia: { isGuild: true, members: [] },
    },
  });
  const backups = await readdir(rutaDe(guildId, 'backups'));
  assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(await readFile(path.join(rutaDe(guildId, 'backups'), backups[0]), 'utf8')), legacy);

  // Idempotente: una segunda carga no vuelve a migrar ni a hacer backup.
  await loadConfig(guildId);
  assert.equal((await readdir(rutaDe(guildId, 'backups'))).length, 1);
});

test('migración: sin albionGuild, el primero de la lista vieja pasa a ser el gremio principal', async () => {
  const guildId = await makeGuild({ guilds: ['VIPS', 'Otro'], squads: {} }, { albionGuild: null });
  await loadConfig(guildId);
  assert.equal((await getConfig(guildId)).albionGuild, 'VIPS');
  assert.deepEqual(Object.keys((await readSquadsFile(guildId)).squads), ['Otro']);
});

test('migración: una mutación sobre un fichero viejo lo convierte antes de aplicarse', async () => {
  const guildId = await makeGuild({ guilds: ['FOAB'], squads: { raf: ['Uno'] } });
  await addPlayers(guildId, 'raf', 'Dos');
  assert.deepEqual(await readSquadsFile(guildId), { squads: { raf: { isGuild: false, members: ['Uno', 'Dos'] } } });
});

// --- reglas de /squads sobre squads de gremio ---

const BASE = { squads: { raf: { isGuild: false, members: ['Uno'] }, Dementia: { isGuild: true, members: [] } } };

test('/squads add sobre un squad de gremio: rechazado explicando de dónde salen sus miembros', async () => {
  const guildId = await makeGuild(BASE);
  await assert.rejects(
    () => addPlayers(guildId, 'dementia', 'Alguien'),
    (error) => error instanceof SquadCommandError && /salen del gremio/.test(error.message),
  );
  assert.deepEqual(await readSquadsFile(guildId), BASE, 'no debe tocar el fichero');
});

test('/squads remove y move sobre un squad de gremio: también rechazados', async () => {
  const guildId = await makeGuild(BASE);
  await assert.rejects(() => removePlayer(guildId, 'Dementia', 'Alguien'), /salen del gremio/);
  await assert.rejects(() => movePlayer(guildId, 'Uno', 'DEMENTIA'), /salen del gremio/);
  assert.deepEqual(await readSquadsFile(guildId), BASE);
});

test('/squads create de gremio apuntando al gremio principal: rechazado (ya es MAIN ZERG)', async () => {
  const guildId = await makeGuild(BASE);
  await assert.rejects(
    () => createSquad(guildId, 'foab', { isGuild: true }),
    (error) => error instanceof SquadCommandError && /MAIN ZERG/.test(error.message),
  );
  assert.deepEqual(await readSquadsFile(guildId), BASE);
});

test('/squads create: rechaza un nombre que ya existe, sea del tipo que sea', async () => {
  const guildId = await makeGuild(BASE);
  await assert.rejects(() => createSquad(guildId, 'RAF', { isGuild: true }), /Ya existe un squad de jugadores/);
  await assert.rejects(() => createSquad(guildId, 'dementia'), /Ya existe un squad de gremio/);
});

test('/squads create de gremio: guarda el nombre con su casing y espacios; uno de jugadores, vacío y sin isGuild', async () => {
  const guildId = await makeGuild({ squads: {} });
  await createSquad(guildId, '  Los Bombas  ', { isGuild: true });
  await createSquad(guildId, 'nuevo');
  assert.deepEqual(await readSquadsFile(guildId), {
    squads: {
      'Los Bombas': { isGuild: true, members: [] },
      nuevo: { isGuild: false, members: [] },
    },
  });
});

test('/squads rename de un squad de gremio cambia a qué gremio sigue (y no puede apuntar al principal)', async () => {
  const guildId = await makeGuild(BASE);
  const { report } = await renameSquad(guildId, 'dementia', 'Dementia Two');
  assert.deepEqual(report, { oldKey: 'Dementia', newKey: 'Dementia Two', isGuild: true });
  assert.deepEqual(Object.keys((await readSquadsFile(guildId)).squads), ['raf', 'Dementia Two']);

  await assert.rejects(() => renameSquad(guildId, 'dementia two', 'FOAB'), /MAIN ZERG/);
});

test('/squads delete de un squad de gremio lo deja de seguir', async () => {
  const guildId = await makeGuild(BASE);
  const { report } = await deleteSquad(guildId, 'dementia');
  assert.equal(report.isGuild, true);
  assert.deepEqual(Object.keys((await readSquadsFile(guildId)).squads), ['raf']);
});
