import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtemp, rm, access, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// DATA_DIR temporal, fijado ANTES de importar nada que lo lea.
const DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'guild-lifecycle-test-'));
process.env.DATA_DIR = DATA_DIR;
after(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
});

const { ChannelType } = await import('discord.js');
const { getConfig, setConfig, rutaDe, existeConfig } = await import('./services/guildStore.js');
const { createSquad } = await import('./services/squadsStore.js');
const { loadConfig } = await import('./services/config.js');
const { addRaffle, loadRaffles } = await import('./services/rafflesStore.js');
const { parseAllowedGuildIds, onGuildPresent, onGuildRemoved, reconcileGuilds, findWelcomeChannel } = await import(
  './guildLifecycle.js'
);
const { rejectOutsideGuild } = await import('./permissions.js');
const { initializeRaffles, handleRaffleReactionAdd } = await import('./raffleScheduler.js');
const { countGuilds } = await import('./commands/health.js');

let nextGuild = 600000000000000000n;
function newGuildId() {
  nextGuild += 1n;
  return String(nextGuild);
}

const exists = (filePath) => access(filePath).then(() => true, () => false);

function makeChannel(id, { writable = true, rawPosition = 0, type = ChannelType.GuildText } = {}) {
  const sent = [];
  return {
    id,
    type,
    rawPosition,
    permissionsFor: () => ({ has: () => writable }),
    send: async (content) => sent.push(content),
    _sent: sent,
  };
}

// Por defecto, un servidor de Discord en español.
function makeGuild(
  id,
  { name = `Servidor ${id}`, systemChannel = null, channels = [], available = true, preferredLocale = 'es-ES' } = {},
) {
  let left = false;
  return {
    id,
    name,
    preferredLocale,
    available,
    systemChannel,
    channels: { cache: new Map(channels.map((channel) => [channel.id, channel])) },
    members: { me: { id: 'bot' } },
    leave: async () => {
      left = true;
    },
    get _left() {
      return left;
    },
  };
}

// --- ALLOWED_GUILD_IDS ---

test('parseAllowedGuildIds: vacía o sin definir acepta cualquiera; con ids, solo esos', () => {
  assert.equal(parseAllowedGuildIds(undefined), null);
  assert.equal(parseAllowedGuildIds(' , '), null);
  assert.deepEqual([...parseAllowedGuildIds(' 111111111111111111 ,222222222222222222,')], [
    '111111111111111111',
    '222222222222222222',
  ]);
});

test('guildCreate fuera de ALLOWED_GUILD_IDS: sale y no crea nada en disco', async () => {
  const guildId = newGuildId();
  const guild = makeGuild(guildId, { systemChannel: makeChannel('c1') });

  const result = await onGuildPresent(guild, { allowed: new Set(['999999999999999999']) });

  assert.equal(result, 'left');
  assert.equal(guild._left, true);
  assert.equal(await exists(rutaDe(guildId)), false);
  assert.equal(guild.systemChannel._sent.length, 0);
});

// --- guildCreate ---

test('guildCreate: servidor nuevo -> config.json por defecto, sin squads, y bienvenida en el canal de sistema', async () => {
  const guildId = newGuildId();
  const system = makeChannel('sys');
  const guild = makeGuild(guildId, { name: 'Nuevo', systemChannel: system });

  assert.equal(await onGuildPresent(guild, { allowed: null }), 'new');

  const config = JSON.parse(await readFile(rutaDe(guildId, 'config.json'), 'utf8'));
  assert.equal(config.activo, true);
  assert.equal(config.nombre, 'Nuevo');
  assert.equal(config.officerRoleId, null);
  assert.equal(config.albionGuild, null);

  // Ni una copia del semilla: el servidor nuevo no tiene squads.
  assert.equal(await exists(rutaDe(guildId, 'squads.json')), false);
  assert.equal((await loadConfig(guildId)).squadOrder.length, 0);

  assert.equal(system._sent.length, 1);
  const lines = system._sent[0].split('\n');
  assert.equal(lines.length, 3);
  assert.match(system._sent[0], /administrador[\s\S]*`\/config view`/);
});

test('un servidor nuevo creado en un Discord en español arranca con idioma "es"; en otro idioma, "en"', async () => {
  for (const [preferredLocale, expected] of [
    ['es-ES', 'es'],
    ['es-419', 'es'],
    ['en-US', 'en'],
    ['de', 'en'],
  ]) {
    const guildId = newGuildId();
    const system = makeChannel('sys');
    await onGuildPresent(makeGuild(guildId, { systemChannel: system, preferredLocale }), { allowed: null });
    assert.equal((await getConfig(guildId)).idioma, expected, preferredLocale);
    // La bienvenida ya sale en ese idioma.
    assert.match(system._sent[0], expected === 'es' ? /Todavía no estoy configurado/ : /not set up/, preferredLocale);
  }
});

test('al arrancar, un servidor que ya existía sin idioma (config de antes) toma el de su Discord', async () => {
  const guildId = newGuildId();
  await setConfig(guildId, { albionGuild: 'FOAB' }); // existe, sin idioma
  assert.equal((await getConfig(guildId)).idioma, null);

  const guild = makeGuild(guildId, { systemChannel: makeChannel('sys'), preferredLocale: 'es-ES' });
  assert.equal(await onGuildPresent(guild, { allowed: null }), 'active');
  assert.equal((await getConfig(guildId)).idioma, 'es');
  assert.equal(guild.systemChannel._sent.length, 0, 'un servidor que ya existía no recibe bienvenida');
});

test('un idioma elegido con /config language no se pisa al arrancar aunque el Discord esté en otro', async () => {
  const guildId = newGuildId();
  await setConfig(guildId, { idioma: 'en' });
  await onGuildPresent(makeGuild(guildId, { preferredLocale: 'es-ES' }), { allowed: null });
  assert.equal((await getConfig(guildId)).idioma, 'en');
});

test('bienvenida: sin canal de sistema escribible, el primer canal de texto donde pueda escribir', () => {
  const guild = makeGuild(newGuildId(), {
    systemChannel: makeChannel('sys', { writable: false }),
    channels: [
      makeChannel('voz', { type: ChannelType.GuildVoice, rawPosition: 0 }),
      makeChannel('bloqueado', { writable: false, rawPosition: 1 }),
      makeChannel('tercero', { rawPosition: 3 }),
      makeChannel('segundo', { rawPosition: 2 }),
    ],
  });
  assert.equal(findWelcomeChannel(guild).id, 'segundo');
  assert.equal(findWelcomeChannel(makeGuild(newGuildId(), { channels: [makeChannel('x', { writable: false })] })), null);
});

// --- guildDelete y vuelta ---

test('guildDelete: no borra nada, marca activo=false con la fecha; al volver recupera config y squads', async () => {
  const guildId = newGuildId();
  const guild = makeGuild(guildId, { systemChannel: makeChannel('sys') });
  await onGuildPresent(guild, { allowed: null });
  await setConfig(guildId, { officerRoleId: '700000000000000001', albionGuild: 'FOAB' });
  await createSquad(guildId, 'foab');

  assert.equal(await onGuildRemoved(guild), true);
  const inactive = await getConfig(guildId);
  assert.equal(inactive.activo, false);
  assert.ok(Date.parse(inactive.inactivoDesde));
  assert.equal(await exists(rutaDe(guildId, 'squads.json')), true);

  const back = makeGuild(guildId, { systemChannel: makeChannel('sys') });
  assert.equal(await onGuildPresent(back, { allowed: null }), 'returned');
  const config = await getConfig(guildId);
  assert.equal(config.activo, true);
  assert.equal(config.inactivoDesde, null);
  assert.equal(config.officerRoleId, '700000000000000001');
  assert.equal(config.albionGuild, 'FOAB');
  assert.deepEqual((await loadConfig(guildId)).squadOrder, ['foab']);
  assert.match(back.systemChannel._sent[0], /configuración y los squads/);
});

test('guildDelete por caída de Discord (available=false): no lo marca inactivo', async () => {
  const guildId = newGuildId();
  await onGuildPresent(makeGuild(guildId), { allowed: null });

  assert.equal(await onGuildRemoved(makeGuild(guildId, { available: false })), false);
  assert.equal((await getConfig(guildId)).activo, true);
});

test('guildDelete de un servidor sin carpeta (del que salió por la lista blanca): no crea nada', async () => {
  const guildId = newGuildId();
  assert.equal(await onGuildRemoved(makeGuild(guildId)), false);
  assert.equal(await existeConfig(guildId), false);
});

// --- al arrancar ---

test('reconcileGuilds: da de alta los que faltan, marca inactivos los que ya no están y sale de los no permitidos', async () => {
  const present = newGuildId();
  const gone = newGuildId();
  const foreign = newGuildId();
  await onGuildPresent(makeGuild(gone), { allowed: null });

  const presentGuild = makeGuild(present, { systemChannel: makeChannel('sys') });
  const foreignGuild = makeGuild(foreign);
  const client = { guilds: { cache: new Map([[present, presentGuild], [foreign, foreignGuild]]) } };

  await reconcileGuilds(client, { allowed: new Set([present, gone]) });

  assert.equal((await getConfig(present)).activo, true);
  assert.equal(presentGuild.systemChannel._sent.length, 1);
  assert.equal((await getConfig(gone)).activo, false);
  assert.equal(foreignGuild._left, true);
  assert.equal(await existeConfig(foreign), false);
});

test('reconcileGuilds: un servidor ya activo no recibe otra bienvenida en cada arranque', async () => {
  const guildId = newGuildId();
  const guild = makeGuild(guildId, { systemChannel: makeChannel('sys') });
  await onGuildPresent(guild, { allowed: null });
  await reconcileGuilds({ guilds: { cache: new Map([[guildId, guild]]) } }, { allowed: null });
  assert.equal(guild.systemChannel._sent.length, 1);
});

// --- mensajes directos ---

function makeDmInteraction({ autocomplete = false } = {}) {
  const calls = [];
  return {
    locale: 'es-ES',
    inGuild: () => false,
    isAutocomplete: () => autocomplete,
    isRepliable: () => !autocomplete,
    reply: async (payload) => calls.push({ type: 'reply', payload }),
    respond: async (choices) => calls.push({ type: 'respond', choices }),
    _calls: calls,
  };
}

test('interacción por mensaje directo: responde que solo funciona dentro de un servidor', async () => {
  const interaction = makeDmInteraction();
  assert.equal(await rejectOutsideGuild(interaction), true);
  assert.equal(interaction._calls[0].payload.ephemeral, true);
  assert.match(interaction._calls[0].payload.embeds[0].toJSON().description, /solo funciona dentro de un servidor/);

  const autocomplete = makeDmInteraction({ autocomplete: true });
  assert.equal(await rejectOutsideGuild(autocomplete), true);
  assert.deepEqual(autocomplete._calls, [{ type: 'respond', choices: [] }]);

  assert.equal(await rejectOutsideGuild({ inGuild: () => true }), false);
});

// --- sorteos: todos los servidores, y el servidor sale del mensaje ---

test('initializeRaffles: reanuda los sorteos de TODOS los servidores, no de uno', async () => {
  const a = newGuildId();
  const b = newGuildId();
  const past = Date.now() - 60_000;
  await addRaffle({ id: 'ra', guildId: a, channelId: 'ca', messageId: 'ma', endsAt: past, creatorId: 'u' });
  await addRaffle({ id: 'rb', guildId: b, channelId: 'cb', messageId: 'mb', endsAt: past, creatorId: 'u' });

  const fetched = [];
  const client = {
    channels: {
      fetch: async (id) => {
        fetched.push(id);
        throw new Error('canal borrado'); // se resuelve quitándolo de su raffles.json
      },
    },
  };
  await initializeRaffles(client);

  assert.ok(fetched.includes('ca') && fetched.includes('cb'));
  assert.deepEqual(await loadRaffles(a), []);
  assert.deepEqual(await loadRaffles(b), []);
});

function makeReaction({ guildId, messageId, removed }) {
  return {
    partial: false,
    emoji: { name: '🎉' },
    message: {
      id: messageId,
      partial: false,
      guild: {
        id: guildId,
        members: { me: { id: 'bot' }, fetch: async () => ({ roles: { cache: new Map() } }) },
      },
      channel: { permissionsFor: () => ({ has: () => true }) },
    },
    users: { remove: async (userId) => removed.push(userId) },
  };
}

test('reacción a un sorteo antiguo: el servidor sale del mensaje, no de una variable', async () => {
  const a = newGuildId();
  const b = newGuildId();
  await addRaffle({
    id: 'r-rol',
    guildId: a,
    channelId: 'c',
    messageId: 'msg-1',
    endsAt: Date.now() + 3_600_000,
    creatorId: 'u',
    roleId: 'rol-a',
  });

  // Mismo id de mensaje en otro servidor: no es su sorteo, no se toca.
  const removedInB = [];
  await handleRaffleReactionAdd(makeReaction({ guildId: b, messageId: 'msg-1', removed: removedInB }), { id: 'x', bot: false });
  assert.deepEqual(removedInB, []);

  // En su servidor, sin el rol: se le quita la reacción.
  const removedInA = [];
  await handleRaffleReactionAdd(makeReaction({ guildId: a, messageId: 'msg-1', removed: removedInA }), { id: 'x', bot: false });
  assert.deepEqual(removedInA, ['x']);
});

// --- /health ---

test('/health: cuenta servidores y cuántos tienen la configuración completa', async () => {
  const complete = newGuildId();
  const partial = newGuildId();
  await setConfig(complete, {
    officerRoleId: '1',
    logChannelId: '2',
    albionGuild: 'FOAB',
    albionbbGuildId: 'abc',
  });
  await setConfig(partial, { officerRoleId: '1' });

  const client = { guilds: { cache: new Map([[complete, {}], [partial, {}]]) } };
  assert.deepEqual(await countGuilds(client), { total: 2, complete: 1 });
});
