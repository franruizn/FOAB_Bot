import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// /raffle-cancel de punta a punta: el sorteo se crea con /raffle real, el
// temporizador es el real de raffleScheduler.js (con setTimeout simulado), y
// "vencer" es avanzar el reloj: si el temporizador siguiera vivo tras
// cancelar, el resultado se publicaría aquí.

const DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'raffle-cancel-test-'));
process.env.DATA_DIR = DATA_DIR;

const { setConfig } = await import('../services/guildStore.js');
const { loadRaffles, addRaffle } = await import('../services/rafflesStore.js');
const { execute: startRaffle } = await import('./sorteo.js');
const { execute: cancel } = await import('./raffleCancel.js');
const { cancelRaffle, resolveRaffle } = await import('../raffleScheduler.js');
const { FakeUser, FakeMessage, FakeChannel, makeClient, makeInteraction, withRolls, FIXED_NOW } = await import('../__fixtures__/raffleHarness.js');

const GUILD = '600000000000000001';
const MINUTES = 30;

before(() => setConfig(GUILD, { officerRoleId: 'officer-role', idioma: 'es' }));
after(() => rm(DATA_DIR, { recursive: true, force: true }));

// Reloj y setTimeout simulados durante todo el test: el sorteo se crea, se
// cancela (o no) y luego se hace vencer con tick().
function freezeClock(t) {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: FIXED_NOW });
  t.after(() => mock.timers.reset());
}

// Espera (con tiempo real, no el simulado) a que `condition` se cumpla, hasta
// `ms`. La resolución de un sorteo hace I/O de ficheros, que no avanza con el
// reloj simulado.
async function waitFor(condition, ms = 1500) {
  const start = performance.now();
  while (performance.now() - start < ms) {
    if (await condition()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return false;
}

let channelCount = 0;

/** Crea un sorteo real con /raffle en un canal nuevo, con `joined` apuntados. */
async function openRaffle({ joined = ['a', 'b', 'c'], integers = {} } = {}) {
  const channel = new FakeChannel(`chan-${++channelCount}`);
  const interaction = makeInteraction({ guildId: GUILD, channel, integers: { minutes: MINUTES, ...integers } });
  // El temporizador resuelve con interaction.client: tiene que encontrar el canal.
  interaction.client = makeClient({ channels: [channel] });
  await startRaffle(interaction);
  const raffle = (await loadRaffles(GUILD)).find((r) => r.channelId === channel.id);
  assert.ok(raffle, 'el sorteo se creó');
  const announcement = channel.store.get(raffle.messageId);
  announcement.addReaction('🎉', joined.map((id) => new FakeUser(id)));
  return { channel, raffle, announcement };
}

const isResult = (payload) => payload.embeds?.[0]?.toJSON?.().title === '🎲 Resultados del sorteo 🎲';

/**
 * Interacción de /raffle-cancel. `click`: 'confirm', 'keep' o null (no pulsa:
 * vence la espera). `beforeClick` corre mientras se espera el botón.
 */
function makeCancelInteraction({ channel, userId = 'creator-1', roles = ['officer-role'], click = 'confirm', beforeClick = null }) {
  const calls = { replies: [], deferred: [], edits: [], waits: [], button: [] };
  let lastPrompt = null;
  const buttonFor = (customId) => ({
    customId,
    user: { id: userId },
    update: async (payload) => calls.button.push({ type: 'update', payload }),
    deferUpdate: async () => calls.button.push({ type: 'deferUpdate' }),
    editReply: async (payload) => calls.button.push({ type: 'editReply', payload }),
  });
  const prompt = {
    awaitMessageComponent: async (options) => {
      calls.waits.push(options);
      if (beforeClick) await beforeClick();
      if (!click) throw new Error('Collector received no interactions before ending with reason: time');
      const [confirm, keep] = lastPrompt.components[0].toJSON().components;
      return buttonFor(click === 'confirm' ? confirm.custom_id : keep.custom_id);
    },
  };
  return {
    id: `cancel-${channel.id}-${userId}`,
    guildId: GUILD,
    channelId: channel.id,
    channel,
    locale: 'es-ES',
    user: { id: userId, tag: `${userId}#0001` },
    member: { roles: { cache: new Map(roles.map((role) => [role, true])) } },
    reply: async (payload) => calls.replies.push(payload),
    deferReply: async (payload) => calls.deferred.push(payload),
    editReply: async (payload) => {
      calls.edits.push(payload);
      if (payload.components?.length) lastPrompt = payload;
      return prompt;
    },
    calls,
  };
}

const lastButtonText = (interaction) => interaction.calls.button.at(-1)?.payload?.content;

// ============================================================
// Cancelar de verdad
// ============================================================

test('sin cancelar, el sorteo se resuelve al vencer (control: así el test de abajo prueba algo)', async (t) => {
  freezeClock(t);
  const { channel } = await openRaffle();
  await withRolls([10, 20, 30], async () => {
    mock.timers.tick(MINUTES * 60_000 + 1);
    assert.ok(await waitFor(() => channel.sent.some(isResult)), 'se publica el resultado al vencer');
  });
});

test('cancelar un sorteo activo: sale de raffles.json, el anuncio lo dice, se avisa en el canal y NO se resuelve al vencer', async (t) => {
  freezeClock(t);
  const { channel, raffle, announcement } = await openRaffle();
  const interaction = makeCancelInteraction({ channel });

  await cancel(interaction);

  assert.equal((await loadRaffles(GUILD)).some((r) => r.id === raffle.id), false, 'fuera de raffles.json');
  assert.equal(lastButtonText(interaction), 'Sorteo cancelado.');

  assert.equal(announcement.content, '🚫 **Sorteo cancelado** por <@creator-1>. No habrá ganador.');
  assert.deepEqual(announcement.edits.at(-1).allowedMentions, { parse: [] });
  assert.equal(announcement.reactions.cache.size, 0, 'se quitan las reacciones');

  const notice = channel.sent.at(-1);
  assert.equal(notice.content, '🚫 <@creator-1> ha cancelado el sorteo de <@creator-1>. No habrá ganador.');
  assert.deepEqual(notice.reply, { messageReference: raffle.messageId, failIfNotExists: false });
  assert.deepEqual(notice.allowedMentions, { parse: [] });

  // Vence el plazo. Hay tiradas de sobra (si el temporizador siguiera vivo, el
  // sorteo se resolvería y publicaría): lo que se comprueba es que nadie tira.
  const sentBefore = channel.sent.length;
  const rolls = mock.method(crypto, 'randomInt', () => 50);
  t.after(() => rolls.mock.restore());
  mock.timers.tick(MINUTES * 60_000 + 1);
  assert.equal(await waitFor(() => channel.sent.length > sentBefore || rolls.mock.callCount() > 0, 500), false);
  assert.equal(rolls.mock.callCount(), 0, 'no se ha tirado ningún dado');
  assert.equal(channel.sent.some(isResult), false, 'no se publica ningún resultado');
});

test('la confirmación: 30 segundos, solo para quien lanzó el comando, y dice cuántos se han apuntado', async (t) => {
  freezeClock(t);
  const { channel } = await openRaffle({ joined: ['a', 'b', 'c'] });
  const interaction = makeCancelInteraction({ channel, click: 'keep' });

  await cancel(interaction);

  assert.deepEqual(interaction.calls.deferred, [{ ephemeral: true }]);
  const [wait] = interaction.calls.waits;
  assert.equal(wait.time, 30_000);
  assert.equal(wait.filter({ user: { id: 'creator-1' } }), true);
  assert.equal(wait.filter({ user: { id: 'someone-else' } }), false, 'otra persona no puede pulsar el botón');

  const prompt = interaction.calls.edits[0].embeds[0].toJSON();
  assert.equal(prompt.title, '¿Cancelar este sorteo?');
  assert.match(prompt.description, /Nadie ganará y no se puede deshacer\./);
  assert.match(prompt.description, /Hay \*\*3\*\* personas apuntadas\./);
});

test('"Mantenerlo" y dejar pasar los 30 segundos no tocan el sorteo', async (t) => {
  freezeClock(t);
  const { channel, raffle } = await openRaffle();

  const kept = makeCancelInteraction({ channel, click: 'keep' });
  await cancel(kept);
  assert.equal(lastButtonText(kept), 'El sorteo sigue en marcha.');

  const expired = makeCancelInteraction({ channel, click: null });
  await cancel(expired);
  assert.equal(expired.calls.edits.at(-1).content, 'Se acabó el tiempo: el sorteo sigue en marcha.');

  assert.ok((await loadRaffles(GUILD)).some((r) => r.id === raffle.id), 'sigue en raffles.json');
  await withRolls([10, 20, 30], async () => {
    mock.timers.tick(MINUTES * 60_000 + 1);
    assert.ok(await waitFor(() => channel.sent.some(isResult)), 'y se resuelve al vencer');
  });
});

// ============================================================
// Sin sorteo, sin permiso
// ============================================================

test('sin sorteo activo en el canal: lo dice, sin botones ni errores', async () => {
  const channel = new FakeChannel('chan-empty');
  const interaction = makeCancelInteraction({ channel });

  await cancel(interaction);

  assert.equal(interaction.calls.replies.length, 1);
  const [reply] = interaction.calls.replies;
  assert.equal(reply.ephemeral, true);
  assert.equal(reply.embeds[0].toJSON().title, 'No hay sorteo activo');
  assert.equal(reply.embeds[0].toJSON().description, 'No hay ningún sorteo activo en este canal.');
  assert.equal(interaction.calls.deferred.length, 0, 'ni siquiera pide confirmación');
});

test('alguien que no es oficial ni lo creó no puede cancelarlo, y el sorteo sigue', async (t) => {
  freezeClock(t);
  const { channel, raffle } = await openRaffle();
  const interaction = makeCancelInteraction({ channel, userId: 'random-user', roles: [] });

  await cancel(interaction);

  const [reply] = interaction.calls.replies;
  assert.equal(reply.ephemeral, true);
  assert.equal(reply.embeds[0].toJSON().description, 'Solo el rol de oficiales o quien creó este sorteo puede cancelarlo.');
  assert.equal(interaction.calls.deferred.length, 0);
  assert.ok((await loadRaffles(GUILD)).some((r) => r.id === raffle.id));
});

test('puede cancelarlo quien lo creó aunque no sea oficial, y un oficial aunque no lo creara', async (t) => {
  freezeClock(t);
  const byCreator = await openRaffle();
  const creator = makeCancelInteraction({ channel: byCreator.channel, userId: 'creator-1', roles: [] });
  await cancel(creator);
  assert.equal(lastButtonText(creator), 'Sorteo cancelado.');

  const byOfficer = await openRaffle();
  const officer = makeCancelInteraction({ channel: byOfficer.channel, userId: 'officer-2', roles: ['officer-role'] });
  await cancel(officer);
  assert.equal(lastButtonText(officer), 'Sorteo cancelado.');
  assert.match(byOfficer.channel.sent.at(-1).content, /^🚫 <@officer-2> ha cancelado el sorteo de <@creator-1>/);
});

// ============================================================
// Aislamiento entre canales
// ============================================================

test('cancelar el sorteo del canal A no toca el del canal B: B sigue en el fichero y se resuelve al vencer', async (t) => {
  freezeClock(t);
  const a = await openRaffle();
  const b = await openRaffle();

  await cancel(makeCancelInteraction({ channel: a.channel }));

  const ids = (await loadRaffles(GUILD)).map((r) => r.id);
  assert.equal(ids.includes(a.raffle.id), false);
  assert.equal(ids.includes(b.raffle.id), true);
  assert.equal(b.announcement.edits.length, 0, 'el anuncio de B no se toca');

  const sentInA = a.channel.sent.length;
  await withRolls([10, 20, 30], async () => {
    mock.timers.tick(MINUTES * 60_000 + 1);
    assert.ok(await waitFor(() => b.channel.sent.some(isResult)), 'B se resuelve');
  });
  assert.equal(a.channel.sent.length, sentInA, 'A no');
});

// ============================================================
// Carreras
// ============================================================

test('si otra persona lo cancela mientras se espera el botón, confirmar dice que ya no está', async (t) => {
  freezeClock(t);
  const { channel, raffle } = await openRaffle();
  const interaction = makeCancelInteraction({ channel, beforeClick: () => cancelRaffle(GUILD, raffle.id) });

  await cancel(interaction);

  assert.equal(lastButtonText(interaction), 'Ese sorteo ya terminó o lo canceló otra persona.');
  assert.equal(channel.sent.some((p) => /ha cancelado/.test(p.content ?? '')), false, 'no se anuncia dos veces');
});

test('un sorteo que se está resolviendo en este momento no se puede cancelar', async () => {
  const channel = new FakeChannel('chan-resolving');
  const announcement = new FakeMessage('msg-resolving');
  announcement.addReaction('🎉', [new FakeUser('a')]);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  channel.messages.fetch = async () => {
    await gate;
    return announcement;
  };
  const raffle = { id: 'raffle-resolving', guildId: GUILD, channelId: channel.id, messageId: announcement.id, endsAt: FIXED_NOW, creatorId: 'creator-1' };
  await addRaffle(raffle);

  await withRolls([50], async () => {
    const resolution = resolveRaffle(makeClient({ channels: [channel] }), raffle);
    assert.equal(await cancelRaffle(GUILD, raffle.id), 'resolving');
    release();
    await resolution;
  });
  assert.ok(channel.sent.some(isResult), 'el resultado se publica igualmente');
  assert.equal(await cancelRaffle(GUILD, raffle.id), 'gone', 'y después ya no está');
});
