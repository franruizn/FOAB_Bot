import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'raffle-scheduler-test-'));
process.env.DATA_DIR = DATA_DIR;

const { resolveRaffle, scheduleRaffleResolution, initializeRaffles, pickWinners } = await import('./raffleScheduler.js');
const { loadRaffles, addRaffle } = await import('./services/rafflesStore.js');
const { setConfig } = await import('./services/guildStore.js');
// Servidor por defecto de los sorteos sin rol (los de rol traen el suyo).
const DEFAULT_GUILD_ID = '100000000000000001';

after(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
});

// Los resultados de un sorteo son públicos: salen en el idioma del servidor.
// Todos los servidores de este fichero están en español.
before(async () => {
  for (const guildId of [DEFAULT_GUILD_ID, '200000000000000001', '200000000000000002', '200000000000000003', '200000000000000004', '200000000000000005', '200000000000000006']) {
    await setConfig(guildId, { idioma: 'es' });
  }
});

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Dobles mínimos, locales a este fichero: un sorteo necesita reacciones y
// message.content, así que aquí van los suyos, con duck-typing (solo lo que
// raffleScheduler.js llama de verdad).

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

function makeFakeClient(channelsById, guildsById = new Map()) {
  return {
    channels: {
      fetch: async (id) => channelsById.get(id) ?? Promise.reject(new Error(`unknown channel ${id}`)),
    },
    guilds: {
      fetch: async (id) => guildsById.get(id) ?? Promise.reject(new Error(`unknown guild ${id}`)),
    },
  };
}

function lastContent(channel) {
  return channel.sentPayloads.at(-1)?.content;
}

function lastEmbed(channel) {
  return channel.sentPayloads.at(-1)?.embeds[0].toJSON();
}

// Dobles para el filtrado por rol: un guild con roles y miembros, con
// duck-typing (solo lo que filterByRole()/handleRaffleReactionAdd() llaman).

class FakeGuildMember {
  constructor(id, roleIds = []) {
    this.id = id;
    this.roles = { cache: new Set(roleIds) };
  }
}

class FakeGuild {
  constructor(id, { roleIds = [], membersById = new Map() } = {}) {
    this.id = id;
    this._roleIds = new Set(roleIds);
    this._membersById = membersById;
    this.roles = {
      fetch: async (roleId) => (this._roleIds.has(roleId) ? { id: roleId } : null),
    };
    this.members = {
      fetch: async (userId) => {
        const member = this._membersById.get(userId);
        if (!member) throw new Error(`Unknown Member ${userId}`);
        return member;
      },
    };
  }
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

  const raffle = { id: 'raffle-1', guildId: DEFAULT_GUILD_ID, channelId: CHANNEL_ID, messageId: announcement.id, creatorId: 'creator-1' };

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

  const raffle = { id: 'raffle-2', guildId: DEFAULT_GUILD_ID, channelId: CHANNEL_ID, messageId: announcement.id, creatorId: 'creator-2' };
  await addRaffle(raffle);

  await resolveRaffle(client, raffle);

  const payload = channel.sentPayloads.at(-1);
  assert.equal(payload.content, undefined, 'sin participantes no hay texto plano con menciones, solo el embed');
  assert.match(payload.embeds[0].toJSON().description, /Nadie participó/);
  assert.ok(!(await loadRaffles(DEFAULT_GUILD_ID)).some((r) => r.id === 'raffle-2'), 'debe quitarse de raffles.json');
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

  const raffle = { id: 'raffle-3', guildId: DEFAULT_GUILD_ID, channelId: CHANNEL_ID, messageId: announcement.id, creatorId: 'creator-3' };
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

  const raffle = { id: 'raffle-4', guildId: DEFAULT_GUILD_ID, channelId: CHANNEL_ID, messageId: announcement.id, endsAt: Date.now() + 50, creatorId: 'creator-4' };
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

  const raffle = { id: 'raffle-5', guildId: DEFAULT_GUILD_ID, channelId: CHANNEL_ID, messageId: announcement.id, endsAt: Date.now() - 1000, creatorId: 'creator-5' };
  await addRaffle(raffle);

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

  const raffle = { id: 'raffle-6', guildId: DEFAULT_GUILD_ID, channelId: CHANNEL_ID, messageId: announcement.id, endsAt: Date.now() + 80, creatorId: 'creator-6' };
  await addRaffle(raffle);

  await initializeRaffles(client);
  assert.equal(channel.sentPayloads.length, 0, 'todavía no debe haberse resuelto: le quedaba tiempo');

  await wait(250);

  const content = lastContent(channel);
  assert.match(content, /^<@p1> ha ganado el sorteo de <@creator-6>$/);
  assert.doesNotMatch(content, /undefined/);
});

// ============================================================
// resolveRaffle() con raffle.roleId: filtrado por rol al resolver
// ============================================================

test('resolveRaffle(): con rol, solo quienes lo tienen entran en las tiradas (y el footer lo cuenta)', async () => {
  const CHANNEL_ID = 'channel-role-1';
  const GUILD_ID = '200000000000000001';
  const ROLE_ID = 'role-1';
  const channel = new FakeChannel(CHANNEL_ID);
  // p1 y p2 tienen el rol; p3 reaccionó pero no lo tiene.
  const guild = new FakeGuild(GUILD_ID, {
    roleIds: [ROLE_ID],
    membersById: new Map([
      ['p1', new FakeGuildMember('p1', [ROLE_ID])],
      ['p2', new FakeGuildMember('p2', [ROLE_ID])],
      ['p3', new FakeGuildMember('p3', [])],
    ]),
  });
  const client = makeFakeClient(new Map([[CHANNEL_ID, channel]]), new Map([[GUILD_ID, guild]]));

  const announcement = new FakeMessage('msg-role-1', 'anuncio');
  announcement.addReaction('🎉', [new FakeUser('p1'), new FakeUser('p2'), new FakeUser('p3')]);
  channel.store.set(announcement.id, announcement);

  const raffle = { id: 'raffle-role-1', guildId: GUILD_ID, channelId: CHANNEL_ID, messageId: announcement.id, creatorId: 'creator-1', roleId: ROLE_ID };
  await resolveRaffle(client, raffle);

  const content = lastContent(channel);
  assert.match(content, /^<@(p1|p2)> ha ganado el sorteo de <@creator-1>$/, 'el ganador debe tener el rol');

  const embed = lastEmbed(channel);
  assert.match(embed.footer.text, /2 de 3 participantes válidos/);
});

test('resolveRaffle(): un usuario que perdió el rol durante el sorteo queda descartado', async () => {
  const CHANNEL_ID = 'channel-role-2';
  const GUILD_ID = '200000000000000002';
  const ROLE_ID = 'role-2';
  const channel = new FakeChannel(CHANNEL_ID);
  // p2 reaccionó cuando tenía el rol, pero ya no lo tiene al resolver.
  const guild = new FakeGuild(GUILD_ID, {
    roleIds: [ROLE_ID],
    membersById: new Map([
      ['p1', new FakeGuildMember('p1', [ROLE_ID])],
      ['p2', new FakeGuildMember('p2', [])],
    ]),
  });
  const client = makeFakeClient(new Map([[CHANNEL_ID, channel]]), new Map([[GUILD_ID, guild]]));

  const announcement = new FakeMessage('msg-role-2', 'anuncio');
  announcement.addReaction('🎉', [new FakeUser('p1'), new FakeUser('p2')]);
  channel.store.set(announcement.id, announcement);

  const raffle = { id: 'raffle-role-2', guildId: GUILD_ID, channelId: CHANNEL_ID, messageId: announcement.id, creatorId: 'creator-2', roleId: ROLE_ID };
  await resolveRaffle(client, raffle);

  const content = lastContent(channel);
  assert.match(content, /^<@p1> ha ganado el sorteo de <@creator-2>$/, 'p2 ya no tiene el rol y no debe poder ganar');
});

test('resolveRaffle(): un usuario que se fue del servidor queda descartado sin fallar', async () => {
  const CHANNEL_ID = 'channel-role-3';
  const GUILD_ID = '200000000000000003';
  const ROLE_ID = 'role-3';
  const channel = new FakeChannel(CHANNEL_ID);
  // p2 reaccionó pero ya no está en el guild: members.fetch('p2') rechaza.
  const guild = new FakeGuild(GUILD_ID, {
    roleIds: [ROLE_ID],
    membersById: new Map([['p1', new FakeGuildMember('p1', [ROLE_ID])]]),
  });
  const client = makeFakeClient(new Map([[CHANNEL_ID, channel]]), new Map([[GUILD_ID, guild]]));

  const announcement = new FakeMessage('msg-role-3', 'anuncio');
  announcement.addReaction('🎉', [new FakeUser('p1'), new FakeUser('p2')]);
  channel.store.set(announcement.id, announcement);

  const raffle = { id: 'raffle-role-3', guildId: GUILD_ID, channelId: CHANNEL_ID, messageId: announcement.id, creatorId: 'creator-3', roleId: ROLE_ID };
  await assert.doesNotReject(resolveRaffle(client, raffle));

  const content = lastContent(channel);
  assert.match(content, /^<@p1> ha ganado el sorteo de <@creator-3>$/);
});

test('resolveRaffle(): con rol, si nadie de los que reaccionaron lo tiene, lo dice explícitamente (no es un sorteo vacío)', async () => {
  const CHANNEL_ID = 'channel-role-4';
  const GUILD_ID = '200000000000000004';
  const ROLE_ID = 'role-4';
  const channel = new FakeChannel(CHANNEL_ID);
  const guild = new FakeGuild(GUILD_ID, {
    roleIds: [ROLE_ID],
    membersById: new Map([
      ['p1', new FakeGuildMember('p1', [])],
      ['p2', new FakeGuildMember('p2', [])],
    ]),
  });
  const client = makeFakeClient(new Map([[CHANNEL_ID, channel]]), new Map([[GUILD_ID, guild]]));

  const announcement = new FakeMessage('msg-role-4', 'anuncio');
  announcement.addReaction('🎉', [new FakeUser('p1'), new FakeUser('p2')]);
  channel.store.set(announcement.id, announcement);

  const raffle = { id: 'raffle-role-4', guildId: GUILD_ID, channelId: CHANNEL_ID, messageId: announcement.id, creatorId: 'creator-4', roleId: ROLE_ID };
  await resolveRaffle(client, raffle);

  const payload = channel.sentPayloads.at(-1);
  assert.equal(payload.content, undefined, 'sin ganador no hay texto plano con menciones');
  assert.match(payload.embeds[0].toJSON().description, /2 personas reaccionaron, pero ninguna tenía el rol requerido/);
});

test('resolveRaffle(): si el rol se borró antes de resolver, resuelve sin participantes y lo explica sin reventar', async () => {
  const CHANNEL_ID = 'channel-role-5';
  const GUILD_ID = '200000000000000005';
  const ROLE_ID = 'role-deleted';
  const channel = new FakeChannel(CHANNEL_ID);
  // El guild existe, pero el rol ya no está entre sus roles.
  const guild = new FakeGuild(GUILD_ID, { roleIds: [], membersById: new Map([['p1', new FakeGuildMember('p1', [])]]) });
  const client = makeFakeClient(new Map([[CHANNEL_ID, channel]]), new Map([[GUILD_ID, guild]]));

  const announcement = new FakeMessage('msg-role-5', 'anuncio');
  announcement.addReaction('🎉', [new FakeUser('p1')]);
  channel.store.set(announcement.id, announcement);

  const raffle = { id: 'raffle-role-5', guildId: GUILD_ID, channelId: CHANNEL_ID, messageId: announcement.id, creatorId: 'creator-5', roleId: ROLE_ID };
  await assert.doesNotReject(resolveRaffle(client, raffle));

  const payload = channel.sentPayloads.at(-1);
  assert.equal(payload.content, undefined);
  assert.match(payload.embeds[0].toJSON().description, /el rol requerido para este sorteo ya no existe/i);
});

// ============================================================
// initializeRaffles() con roleId: un sorteo reanudado tras un reinicio
// sigue filtrando por el mismo rol
// ============================================================

test('initializeRaffles(): un sorteo con rol reanudado tras un reinicio sigue filtrando por ese rol', async () => {
  const CHANNEL_ID = 'channel-role-6';
  const GUILD_ID = '200000000000000006';
  const ROLE_ID = 'role-6';
  const channel = new FakeChannel(CHANNEL_ID);
  const guild = new FakeGuild(GUILD_ID, {
    roleIds: [ROLE_ID],
    membersById: new Map([
      ['p1', new FakeGuildMember('p1', [ROLE_ID])],
      ['p2', new FakeGuildMember('p2', [])],
    ]),
  });
  const client = makeFakeClient(new Map([[CHANNEL_ID, channel]]), new Map([[GUILD_ID, guild]]));

  const announcement = new FakeMessage('msg-role-6', 'anuncio');
  announcement.addReaction('🎉', [new FakeUser('p1'), new FakeUser('p2')]);
  channel.store.set(announcement.id, announcement);

  // Plazo ya vencido: se resuelve de inmediato al "reiniciar", como si el
  // bot hubiera estado caído.
  const raffle = {
    id: 'raffle-role-6',
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    messageId: announcement.id,
    endsAt: Date.now() - 1000,
    creatorId: 'creator-6',
    roleId: ROLE_ID,
  };
  await addRaffle(raffle);

  await initializeRaffles(client);

  const content = lastContent(channel);
  assert.match(content, /^<@p1> ha ganado el sorteo de <@creator-6>$/, 'p2 no tiene el rol y no debe poder ganar tras el reinicio');
});

// ============================================================
// pickWinners(): reparto de puestos y desempates
// ============================================================

// Tiradas guionizadas: devuelve `values` en orden y falla si se piden más
// (así un test también comprueba que NO se tiró cuando no tocaba).
function scriptedRandom(values) {
  const queue = [...values];
  const fn = (min, max) => {
    assert.ok(queue.length > 0, `tirada inesperada (${min}-${max})`);
    return queue.shift();
  };
  fn.left = () => queue.length;
  return fn;
}

const rolled = (rolls) => Object.entries(rolls).map(([id, roll]) => ({ user: { id }, roll }));
const ids = (results) => results.map((r) => r.user.id);

test('pickWinners(): un empate que cabe entero en los puestos libres no se rompe', () => {
  const random = scriptedRandom([]);
  const { sorted, tiebreak } = pickWinners(rolled({ p1: 90, p2: 90, p3: 90, p4: 50 }), 3, random);
  assert.deepEqual(ids(sorted.slice(0, 3)), ['p1', 'p2', 'p3']);
  assert.equal(tiebreak, null);
});

test('pickWinners(): un empate más grande que los puestos que quedan se desempata solo entre esos', () => {
  // p1 entra solo; p2/p3/p4 se disputan el último puesto; p5 no tira.
  const random = scriptedRandom([20, 80, 50]);
  const { sorted, tiebreak } = pickWinners(rolled({ p1: 90, p2: 70, p3: 70, p4: 70, p5: 10 }), 2, random);
  assert.deepEqual(ids(sorted), ['p1', 'p3', 'p4', 'p2', 'p5']);
  assert.equal(tiebreak.roll, 70);
  assert.equal(tiebreak.slots, 1);
  assert.equal(tiebreak.rounds, 1);
  assert.equal(tiebreak.random, false);
  assert.deepEqual(ids(tiebreak.participants), ['p2', 'p3', 'p4']);
  assert.equal(sorted[0].roll, 90, 'el roll original no cambia');
});

test('pickWinners(): si la segunda tirada vuelve a empatar en el corte, otra ronda solo entre esos', () => {
  // Ronda 1: p1 y p2 empatan a 90 por 1 puesto (p3 queda fuera). Ronda 2: solo ellos.
  const random = scriptedRandom([90, 90, 10, 30, 60]);
  const { sorted, tiebreak } = pickWinners(rolled({ p1: 50, p2: 50, p3: 50 }), 1, random);
  assert.equal(sorted[0].user.id, 'p2');
  assert.equal(tiebreak.rounds, 2);
  assert.equal(random.left(), 0);
});

test('pickWinners(): un empate en la segunda tirada que cabe entero no pide otra ronda', () => {
  const random = scriptedRandom([80, 80, 10]);
  const { sorted, tiebreak } = pickWinners(rolled({ p1: 50, p2: 50, p3: 50 }), 2, random);
  assert.deepEqual(ids(sorted.slice(0, 2)).sort(), ['p1', 'p2']);
  assert.equal(tiebreak.slots, 2);
  assert.equal(tiebreak.rounds, 1);
});

test('pickWinners(): tras 10 rondas empatados, se elige al azar (sin bucle infinito)', () => {
  let calls = 0;
  const alwaysTie = (min) => {
    calls++;
    return min; // 1 en cada tirada; 0 en la baraja final
  };
  const { sorted, tiebreak } = pickWinners(rolled({ p1: 40, p2: 40 }), 1, alwaysTie);
  assert.equal(tiebreak.rounds, 10);
  assert.equal(tiebreak.random, true);
  assert.equal(calls, 10 * 2 + 1, '10 rondas de 2 tiradas y una elección al azar');
  assert.equal(new Set(ids(sorted)).size, 2);
});

test('pickWinners(): con menos participantes que puestos, ganan todos y no hay desempate', () => {
  const { sorted, tiebreak } = pickWinners(rolled({ p1: 30, p2: 30 }), 3, scriptedRandom([]));
  assert.deepEqual(ids(sorted), ['p1', 'p2']);
  assert.equal(tiebreak, null);
});

test('pickWinners(): con un puesto, un empate por debajo del primero no se desempata (como siempre)', () => {
  const { sorted, tiebreak } = pickWinners(rolled({ p1: 99, p2: 40, p3: 40 }), 1, scriptedRandom([]));
  assert.equal(sorted[0].user.id, 'p1');
  assert.equal(tiebreak, null);
});

test('pickWinners(): con muchos empates, nadie gana dos veces y ningún ganador tiene menos tirada que un no ganador', () => {
  for (let run = 0; run < 300; run++) {
    const results = Array.from({ length: 30 }, (_, i) => ({ user: { id: `p${i}` }, roll: 1 + (run * 7 + i * 13) % 12 }));
    const { sorted } = pickWinners(results, 20);
    const winners = sorted.slice(0, 20);
    assert.equal(sorted.length, 30);
    assert.equal(new Set(ids(winners)).size, 20);
    const minWinner = Math.min(...winners.map((r) => r.roll));
    const maxLoser = Math.max(...sorted.slice(20).map((r) => r.roll));
    assert.ok(minWinner >= maxLoser, `run ${run}: ${minWinner} < ${maxLoser}`);
  }
});

// ============================================================
// resolveRaffle(): varios ganadores y mensaje
// ============================================================

test('resolveRaffle(): 3 puestos y 2 participantes, ganan los dos y el embed lo dice; el mensaje sale en un field', async () => {
  const CHANNEL_ID = 'channel-multi-1';
  const channel = new FakeChannel(CHANNEL_ID);
  const client = makeFakeClient(new Map([[CHANNEL_ID, channel]]));
  const announcement = new FakeMessage('msg-multi-1', 'anuncio');
  announcement.addReaction('🎉', [new FakeUser('p1'), new FakeUser('p2')]);
  channel.store.set(announcement.id, announcement);

  const raffle = {
    id: 'raffle-multi-1',
    guildId: DEFAULT_GUILD_ID,
    channelId: CHANNEL_ID,
    messageId: announcement.id,
    creatorId: 'creator-m',
    winners: 3,
    message: 'Premio: **montura T8**',
  };
  await resolveRaffle(client, raffle);

  assert.match(lastContent(channel), /^<@p[12]> y <@p[12]> han ganado el sorteo de <@creator-m>$/);
  const embed = lastEmbed(channel);
  assert.match(embed.description, /^🏆 \*\*2 ganadores\*\*\n🥇 <@p\d> — `\d+`\n🥈 <@p\d> — `\d+`/);
  assert.match(embed.description, /3 ganadores de 2 participantes: ganan todos\./);
  assert.deepEqual(embed.fields[0], { name: 'Mensaje', value: 'Premio: **montura T8**' });
});

test('resolveRaffle(): un sorteo reanudado conserva sus ganadores y su mensaje', async () => {
  const CHANNEL_ID = 'channel-multi-2';
  const channel = new FakeChannel(CHANNEL_ID);
  const client = makeFakeClient(new Map([[CHANNEL_ID, channel]]));
  const announcement = new FakeMessage('msg-multi-2', 'anuncio');
  announcement.addReaction('🎉', ['p1', 'p2', 'p3', 'p4'].map((id) => new FakeUser(id)));
  channel.store.set(announcement.id, announcement);

  await addRaffle({
    id: 'raffle-multi-2',
    guildId: DEFAULT_GUILD_ID,
    channelId: CHANNEL_ID,
    messageId: announcement.id,
    endsAt: Date.now() - 1000,
    creatorId: 'creator-m',
    winners: 2,
    message: 'Sorteo de la semana',
  });
  await initializeRaffles(client);

  const embed = lastEmbed(channel);
  assert.match(embed.description, /^🏆 \*\*2 ganadores\*\*/);
  assert.equal(embed.fields[0].value, 'Sorteo de la semana');
  assert.match(lastContent(channel), / y .* han ganado el sorteo de <@creator-m>$/);
});
