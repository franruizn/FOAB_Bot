import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Reinicio de verdad, en su propio DATA_DIR (initializeRaffles() recorre
// TODOS los sorteos guardados): el sorteo se crea con el comando real, el
// proceso "muere" (se tira el timer y se carga un raffleScheduler.js nuevo,
// sin nada en memoria) y se resuelve desde raffles.json.

const DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'raffle-restart-test-'));
process.env.DATA_DIR = DATA_DIR;

const { setConfig } = await import('./services/guildStore.js');
const { loadRaffles, addRaffle, removeRaffle } = await import('./services/rafflesStore.js');
const { execute } = await import('./commands/sorteo.js');
const { FakeUser, FakeMessage, FakeChannel, makeClient, makeInteraction, withRolls, withFrozenClock, FIXED_NOW } = await import(
  './__fixtures__/raffleHarness.js'
);

const GUILD = '500000000000000001';
after(() => rm(DATA_DIR, { recursive: true, force: true }));

// Cada "arranque" es un raffleScheduler.js recién cargado (nada en memoria),
// con el reloj media hora después del cierre de los sorteos (FIXED_NOW): con
// el reloj real, un sorteo "vencido" podría seguir vivo y dejar un setTimeout
// real esperando.
let boots = 0;
async function boot(client, rolls = []) {
  const { initializeRaffles } = await import(`./raffleScheduler.js?boot=${++boots}`);
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: FIXED_NOW + 31 * 60_000 });
  try {
    await withRolls(rolls, () => initializeRaffles(client));
  } finally {
    mock.timers.reset();
  }
}

class FakeLogChannel extends FakeChannel {
  constructor(id, guildId) {
    super(id);
    this.guildId = guildId;
  }
  isTextBased() {
    return true;
  }
}

// Silencia el console.error esperado de un test y devuelve lo que se registró.
function captureErrors(t) {
  const logged = [];
  const spy = t.mock.method(console, 'error', (...args) => logged.push(args.map(String).join(' ')));
  return { logged, restore: () => spy.mock.restore() };
}

test('reinicio: un sorteo con mensaje y winners:3 conserva las dos cosas al resolverse', async () => {
  await setConfig(GUILD, { officerRoleId: 'officer-role', idioma: 'es' });
  const channel = new FakeChannel('chan-restart');
  const interaction = makeInteraction({ guildId: GUILD, channel, integers: { winners: 3 }, strings: { message: 'Premio:\\n**montura T8**' } });

  // withFrozenClock descarta el setTimeout del sorteo al salir: es lo que se
  // pierde cuando el proceso muere.
  await withFrozenClock(() => execute(interaction));
  const [stored] = await loadRaffles(GUILD);
  assert.equal(stored.winners, 3);
  assert.equal(stored.message, 'Premio:\n**montura T8**');

  channel.store.get(stored.messageId).addReaction('🎉', ['a', 'b', 'c', 'd', 'e'].map((id) => new FakeUser(id)));

  // Arranque nuevo media hora y un minuto después del cierre.
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: FIXED_NOW + 31 * 60_000 });
  try {
    const { initializeRaffles } = await import('./raffleScheduler.js?restart');
    await withRolls([10, 50, 90, 30, 70], () => initializeRaffles(makeClient({ channels: [channel] })));
  } finally {
    mock.timers.reset();
  }

  const result = channel.sent.at(-1);
  const embed = result.embeds[0].toJSON();
  assert.equal(result.content, '<@c>, <@e> y <@b> han ganado el sorteo de <@creator-1>');
  assert.match(embed.description, /^🏆 \*\*3 ganadores\*\*\n🥇 <@c> — `90`\n🥈 <@e> — `70`\n🥉 <@b> — `50`/);
  assert.match(embed.description, /se resolvió con retraso/);
  assert.deepEqual(embed.fields[0], { name: 'Mensaje', value: 'Premio:\n**montura T8**' });
  assert.deepEqual(await loadRaffles(GUILD), [], 'resuelto, sale de raffles.json');
});

test('un send del resultado que lanza: el sorteo se cierra, se avisa en el canal de logs y al reiniciar no se reintenta', async (t) => {
  const guildId = '500000000000000002';
  await setConfig(guildId, { officerRoleId: 'officer-role', idioma: 'es', logChannelId: 'logs-1' });

  const channel = new FakeChannel('chan-broken');
  const sendAttempts = [];
  channel.send = async (payload) => {
    sendAttempts.push(payload);
    throw new Error('Missing Permissions');
  };
  const announcement = new FakeMessage('msg-broken');
  announcement.addReaction('🎉', [new FakeUser('a'), new FakeUser('b')]);
  channel.store.set(announcement.id, announcement);
  const logs = new FakeLogChannel('logs-1', guildId);
  const client = makeClient({ channels: [channel, logs] });

  await addRaffle({ id: 'raffle-broken', guildId, channelId: channel.id, messageId: announcement.id, endsAt: FIXED_NOW - 1000, creatorId: 'creator-1', winners: 3, message: 'Premio' });

  const errors = captureErrors(t);
  await boot(client, [40, 60]);
  errors.restore();

  assert.equal(sendAttempts.length, 1, 'intentó publicar el resultado una vez');
  assert.deepEqual(await loadRaffles(guildId), [], 'no se queda en raffles.json');
  assert.ok(errors.logged.some((line) => /raffle-broken.*se cierra igualmente.*Missing Permissions/s.test(line)), 'queda en el log');

  const [notice] = logs.sent;
  const embed = notice.embeds[0].toJSON();
  assert.equal(embed.title, 'Sorteo cerrado sin resultado');
  assert.match(embed.description, /sorteo de <@creator-1> en <#chan-broken>/);
  assert.equal(embed.fields[0].value, '```Missing Permissions```');

  // "Reinicio": sin nada en raffles.json no hay nada que reintentar.
  await boot(client);
  assert.equal(sendAttempts.length, 1, 'el arranque siguiente no lo reintenta');
});

test('un canal del sorteo que ya no existe también lo cierra (y lo avisa), sin bucle en cada arranque', async (t) => {
  const guildId = '500000000000000003';
  await setConfig(guildId, { officerRoleId: 'officer-role', idioma: 'es', logChannelId: 'logs-2' });
  const logs = new FakeLogChannel('logs-2', guildId);
  const client = makeClient({ channels: [logs] });
  await addRaffle({ id: 'raffle-gone', guildId, channelId: 'deleted-channel', messageId: 'm', endsAt: FIXED_NOW - 1000, creatorId: 'creator-1' });

  const errors = captureErrors(t);
  await boot(client);
  errors.restore();

  assert.deepEqual(await loadRaffles(guildId), []);
  assert.match(logs.sent[0].embeds[0].toJSON().description, /<#deleted-channel>/);
});

test('raffles.json: winners se acota a 1-20 al leer, venga lo que venga', async () => {
  const guildId = '500000000000000004';
  const base = { guildId, channelId: 'c', messageId: 'm', endsAt: FIXED_NOW + 60_000, creatorId: 'creator-1' };
  for (const [id, winners] of [['huge', 500], ['zero', 0], ['negative', -3], ['text', 'tres'], ['float', 2.5], ['ok', 7]]) {
    await addRaffle({ ...base, id, winners });
  }
  await addRaffle({ ...base, id: 'old' }); // de antes de existir la opción

  const loaded = await loadRaffles(guildId);
  // Solo se comprueba la lectura: no deben quedar para los arranques siguientes.
  for (const raffle of loaded) await removeRaffle(guildId, raffle.id);
  const byId = Object.fromEntries(loaded.map((r) => [r.id, r.winners]));
  assert.deepEqual(byId, { huge: 20, zero: 1, negative: 1, text: 1, float: 1, ok: 7, old: 1 });
});

test('un sorteo con winners: 500 en el fichero se resuelve con 20 puestos (no revienta el embed)', async () => {
  const guildId = '500000000000000005';
  await setConfig(guildId, { officerRoleId: 'officer-role', idioma: 'es' });
  const channel = new FakeChannel('chan-500');
  const announcement = new FakeMessage('msg-500');
  const ids = Array.from({ length: 30 }, (_, i) => String(1_234_567_890_123_456_000n + BigInt(i)));
  announcement.addReaction('🎉', ids.map((id) => new FakeUser(id)));
  channel.store.set(announcement.id, announcement);
  await addRaffle({ id: 'raffle-500', guildId, channelId: channel.id, messageId: announcement.id, endsAt: FIXED_NOW - 1000, creatorId: 'creator-1', winners: 500 });

  await boot(makeClient({ channels: [channel] }), ids.map((_, i) => 100 - i));

  const embed = channel.sent.at(-1).embeds[0].toJSON();
  assert.match(embed.description, /^🏆 \*\*20 ganadores\*\*/);
  assert.deepEqual(await loadRaffles(guildId), []);
});
