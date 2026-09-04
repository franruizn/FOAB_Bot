import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'raffle-scheduler-test-'));
process.env.DATA_DIR = DATA_DIR;

const { resolveRaffle, scheduleRaffleResolution, initializeRaffles } = await import('./raffleScheduler.js');
const { loadRaffles, addRaffle } = await import('./services/rafflesStore.js');
const { RAFFLES_PATH } = await import('./dataPaths.js');

after(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
});

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Dobles mínimos, locales a este fichero: /cta usa src/testHelpers/discordFakes.js,
// pero un sorteo necesita reacciones y message.content (que ese doble
// compartido no modela), así que aquí van los suyos, con la misma filosofía
// de duck-typing (solo lo que raffleScheduler.js llama de verdad).

class FakeUser {
  constructor(id, bot = false) {
    this.id = id;
    this.bot = bot;
  }
}

class FakeReactionUsers {
  constructor(users) {
    this.users = users; // orden de inserción = orden de "quién reaccionó antes"
  }
  async fetch({ limit, after } = {}) {
    const ids = this.users.map((u) => u.id);
    const startIndex = after ? ids.indexOf(after) + 1 : 0;
    const page = this.users.slice(startIndex, startIndex + limit);
    return new Map(page.map((u) => [u.id, u]));
  }
}

class FakeMessage {
  constructor(id, content) {
    this.id = id;
    this.content = content;
    // El bug real: discord.js Message.toString() devuelve this.content, así
    // que cualquier sitio que interpole el objeto Message en vez del id
    // acaba metiendo este texto entero en el mensaje final.
    this.deleted = false;
    this.reactions = { cache: new Map() };
  }
  toString() {
    return this.content;
  }
  addReaction(emoji, users) {
    this.reactions.cache.set(emoji, { users: new FakeReactionUsers(users) });
  }
}

class FakeChannel {
  constructor(id) {
    this.id = id;
    this.store = new Map();
    this.sentPayloads = [];
    this.isTextBased = () => true;
    this.__forceFetchMessageFail = false;
    this.messages = {
      fetch: async (msgId) => {
        if (this.__forceFetchMessageFail) throw new Error('Unknown Message (forzado)');
        const msg = this.store.get(msgId);
        if (!msg) throw new Error(`Unknown Message ${msgId}`);
        return msg;
      },
    };
  }
  async send(payload) {
    this.sentPayloads.push(payload);
    return new FakeMessage(`sent-${this.sentPayloads.length}`, typeof payload === 'string' ? payload : (payload.content ?? ''));
  }
}

function makeFakeClient(channelsById) {
  return {
    channels: {
      fetch: async (id) => channelsById.get(id) ?? Promise.reject(new Error(`unknown channel ${id}`)),
    },
  };
}

function lastContent(channel) {
  return channel.sentPayloads.at(-1)?.content;
}

// ============================================================
// resolveRaffle(): el mensaje final menciona al CREADOR, nunca cita el
// contenido del anuncio original (el bug real de este fichero)
// ============================================================

test('resolveRaffle(): "ha ganado el sorteo de <@creatorId>" usa raffle.creatorId, no el objeto Message del anuncio', async () => {
  const CHANNEL_ID = 'channel-1';
  const channel = new FakeChannel(CHANNEL_ID);
  const client = makeFakeClient(new Map([[CHANNEL_ID, channel]]));

  // El anuncio real tiene menciones y texto largo — si algo interpola el
  // objeto Message en vez del id, esto es justo lo que se colaría en el
  // mensaje final (Message.toString() === message.content).
  const announcement = new FakeMessage(
    'msg-1',
    '<@&role-1> <@creator-1> ha comenzado un sorteo que terminará <t:123:R>.\n\nReacciona con 🎉 para participar.',
  );
  announcement.addReaction('🎉', [new FakeUser('p1'), new FakeUser('p2')]);
  channel.store.set(announcement.id, announcement);

  const raffle = { id: 'raffle-1', channelId: CHANNEL_ID, messageId: announcement.id, creatorId: 'creator-1' };

  await resolveRaffle(client, raffle);

  const content = lastContent(channel);
  assert.match(content, /^<@p[12]> ha ganado el sorteo de <@creator-1>$/);
  assert.doesNotMatch(content, /Reacciona con/, 'no debe colarse el texto del anuncio original');
  assert.doesNotMatch(content, /object Object/);
});

test('resolveRaffle(): sin ningún participante, avisa y no menciona a nadie', async () => {
  const CHANNEL_ID = 'channel-2';
  const channel = new FakeChannel(CHANNEL_ID);
  const client = makeFakeClient(new Map([[CHANNEL_ID, channel]]));

  const announcement = new FakeMessage('msg-2', 'anuncio');
  announcement.addReaction('🎉', []);
  channel.store.set(announcement.id, announcement);

  const raffle = { id: 'raffle-2', channelId: CHANNEL_ID, messageId: announcement.id, creatorId: 'creator-2' };
  await addRaffle(RAFFLES_PATH, raffle);

  await resolveRaffle(client, raffle);

  const payload = channel.sentPayloads.at(-1);
  assert.equal(payload.content, undefined, 'sin participantes no hay texto plano con menciones, solo el embed');
  assert.match(payload.embeds[0].toJSON().description, /Nadie participó/);
  assert.ok(!(await loadRaffles(RAFFLES_PATH)).some((r) => r.id === 'raffle-2'), 'debe quitarse de raffles.json');
});

test('resolveRaffle(): filtra bots y pagina reacciones por encima de 100', async () => {
  const CHANNEL_ID = 'channel-3';
  const channel = new FakeChannel(CHANNEL_ID);
  const client = makeFakeClient(new Map([[CHANNEL_ID, channel]]));

  const announcement = new FakeMessage('msg-3', 'anuncio');
  const humanUsers = Array.from({ length: 120 }, (_, i) => new FakeUser(`p${i}`));
  const reactors = [...humanUsers, new FakeUser('the-bot-itself', true)];
  announcement.addReaction('🎉', reactors);
  channel.store.set(announcement.id, announcement);

  const raffle = { id: 'raffle-3', channelId: CHANNEL_ID, messageId: announcement.id, creatorId: 'creator-3' };
  await resolveRaffle(client, raffle);

  const content = lastContent(channel);
  assert.match(content, /^<@p\d+> ha ganado el sorteo de <@creator-3>$/, 'el ganador debe ser uno de los 120 humanos, nunca el bot');
});

// ============================================================
// scheduleRaffleResolution(): ya no acepta creatorId aparte — lo toma de
// raffle.creatorId al disparar
// ============================================================

test('scheduleRaffleResolution(): al vencer, resuelve usando raffle.creatorId (sin pasarlo aparte)', async () => {
  const CHANNEL_ID = 'channel-4';
  const channel = new FakeChannel(CHANNEL_ID);
  const client = makeFakeClient(new Map([[CHANNEL_ID, channel]]));

  const announcement = new FakeMessage('msg-4', 'anuncio');
  announcement.addReaction('🎉', [new FakeUser('p1')]);
  channel.store.set(announcement.id, announcement);

  const raffle = { id: 'raffle-4', channelId: CHANNEL_ID, messageId: announcement.id, endsAt: Date.now() + 50, creatorId: 'creator-4' };
  scheduleRaffleResolution(client, raffle);

  await wait(200);

  assert.match(lastContent(channel), /^<@p1> ha ganado el sorteo de <@creator-4>$/);
});

// ============================================================
// initializeRaffles(): tanto el camino "atrasado" como el de "reprogramar"
// deben acabar mencionando al creador real — antes de este fix, el primero
// mencionaba "[object Object]" y el segundo "undefined"
// ============================================================

test('initializeRaffles(): un sorteo cuyo plazo ya pasó se resuelve YA, marcado como retrasado, mencionando al creador real', async () => {
  const CHANNEL_ID = 'channel-5';
  const channel = new FakeChannel(CHANNEL_ID);
  const client = makeFakeClient(new Map([[CHANNEL_ID, channel]]));

  const announcement = new FakeMessage('msg-5', 'anuncio');
  announcement.addReaction('🎉', [new FakeUser('p1')]);
  channel.store.set(announcement.id, announcement);

  const raffle = { id: 'raffle-5', channelId: CHANNEL_ID, messageId: announcement.id, endsAt: Date.now() - 1000, creatorId: 'creator-5' };
  await addRaffle(RAFFLES_PATH, raffle);

  await initializeRaffles(client);

  const content = lastContent(channel);
  assert.match(content, /^<@p1> ha ganado el sorteo de <@creator-5>$/, 'nunca "[object Object]" ni el objeto de opciones');
  const embed = channel.sentPayloads.at(-1).embeds[0].toJSON();
  assert.match(embed.description, /se resolvió con retraso/);
});

test('initializeRaffles(): un sorteo que sigue vivo se reprograma y, al vencer, menciona al creador real (no "undefined")', async () => {
  const CHANNEL_ID = 'channel-6';
  const channel = new FakeChannel(CHANNEL_ID);
  const client = makeFakeClient(new Map([[CHANNEL_ID, channel]]));

  const announcement = new FakeMessage('msg-6', 'anuncio');
  announcement.addReaction('🎉', [new FakeUser('p1')]);
  channel.store.set(announcement.id, announcement);

  const raffle = { id: 'raffle-6', channelId: CHANNEL_ID, messageId: announcement.id, endsAt: Date.now() + 80, creatorId: 'creator-6' };
  await addRaffle(RAFFLES_PATH, raffle);

  await initializeRaffles(client);
  assert.equal(channel.sentPayloads.length, 0, 'todavía no debe haberse resuelto: le quedaba tiempo');

  await wait(250);

  const content = lastContent(channel);
  assert.match(content, /^<@p1> ha ganado el sorteo de <@creator-6>$/);
  assert.doesNotMatch(content, /undefined/);
});
