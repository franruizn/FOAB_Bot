import crypto from 'node:crypto';
import { mock } from 'node:test';

// Dobles y escenarios compartidos por los tests de /raffle y por el script que
// genera raffle-golden.json a partir del código ANTERIOR a winners/message.
// Los escenarios del golden solo usan lo que ya existía (minutes y role): su
// salida tiene que seguir siendo idéntica byte a byte.

export const FIXED_NOW = Date.UTC(2026, 10, 3, 18, 0, 0);

export class FakeUser {
  constructor(id, bot = false) {
    this.id = id;
    this.bot = bot;
  }
}

class FakeReactionUsers {
  constructor(users) {
    this.users = users;
  }
  async fetch({ limit, after } = {}) {
    const ids = this.users.map((u) => u.id);
    const start = after ? ids.indexOf(after) + 1 : 0;
    const page = this.users.slice(start, start + limit);
    return new Map(page.map((u) => [u.id, u]));
  }
}

export class FakeMessage {
  constructor(id, content = '') {
    this.id = id;
    this.content = content;
    this.reactions = { cache: new Map() };
  }
  addReaction(emoji, users) {
    this.reactions.cache.set(emoji, { users: new FakeReactionUsers(users) });
  }
  async react() {}
}

export class FakeChannel {
  constructor(id) {
    this.id = id;
    this.store = new Map();
    this.sent = [];
    this.messages = {
      fetch: async (messageId) => {
        const message = this.store.get(messageId);
        if (!message) throw new Error(`Unknown Message ${messageId}`);
        return message;
      },
    };
  }
  async send(payload) {
    this.sent.push(payload);
    const message = new FakeMessage(`${this.id}-msg-${this.sent.length}`, payload.content ?? '');
    this.store.set(message.id, message);
    return message;
  }
}

export class FakeGuild {
  constructor(id, { roleIds = [], members = {} } = {}) {
    this.id = id;
    this.roles = { fetch: async (roleId) => (roleIds.includes(roleId) ? { id: roleId } : null) };
    this.members = {
      fetch: async (userId) => {
        if (!(userId in members)) throw new Error(`Unknown Member ${userId}`);
        return { id: userId, roles: { cache: new Set(members[userId]) } };
      },
    };
  }
}

export function makeClient({ channels = [], guilds = [] } = {}) {
  const byId = (list) => new Map(list.map((item) => [item.id, item]));
  const channelMap = byId(channels);
  const guildMap = byId(guilds);
  return {
    channels: { fetch: async (id) => channelMap.get(id) ?? Promise.reject(new Error(`unknown channel ${id}`)) },
    guilds: { fetch: async (id) => guildMap.get(id) ?? Promise.reject(new Error(`unknown guild ${id}`)) },
  };
}

export function makeInteraction({ guildId, channel, integers = {}, strings = {}, role = null, locale = 'es-ES' }) {
  const replies = [];
  return {
    guildId,
    channelId: channel.id,
    locale,
    member: { roles: { cache: new Map([['officer-role', true]]) } },
    user: { id: 'creator-1' },
    channel,
    client: {},
    options: {
      getInteger: (name) => ({ minutes: 30, ...integers })[name] ?? null,
      getString: (name) => strings[name] ?? null,
      getRole: () => role,
    },
    reply: async (payload) => replies.push(payload),
    replies,
  };
}

/**
 * Sustituye crypto.randomInt por una cola de tiradas fijas mientras corre
 * `fn`. Falla si se piden más tiradas de las previstas o sobran: así el test
 * también comprueba cuántas veces se tiró.
 */
export async function withRolls(rolls, fn) {
  const queue = [...rolls];
  const spy = mock.method(crypto, 'randomInt', (min, max) => {
    if (queue.length === 0) throw new Error(`tirada no prevista (${min}-${max})`);
    const value = queue.shift();
    if (value < min || value >= max) throw new Error(`tirada ${value} fuera de [${min}, ${max})`);
    return value;
  });
  try {
    return await fn();
  } finally {
    spy.mock.restore();
    if (queue.length > 0) throw new Error(`sobran tiradas: ${queue.join(', ')}`);
  }
}

/** Reloj fijo y setTimeout simulado (el sorteo creado no deja timers vivos). */
export async function withFrozenClock(fn) {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: FIXED_NOW });
  try {
    return await fn();
  } finally {
    mock.timers.reset();
  }
}

// Pasa por JSON, como el golden: una clave a undefined y una ausente son lo mismo.
function serialize(payload) {
  if (typeof payload === 'string') return { content: payload };
  return JSON.parse(JSON.stringify({
    content: payload.content ?? null,
    embeds: (payload.embeds ?? []).map((embed) => (typeof embed.toJSON === 'function' ? embed.toJSON() : embed)),
    reply: payload.reply ?? null,
    allowedMentions: payload.allowedMentions ?? null,
  }));
}

export const GOLDEN_GUILDS = {
  es: '300000000000000001',
  esRaffleRole: '300000000000000002',
  en: '300000000000000003',
  esRoleFilter: '300000000000000004',
};

export async function setupGoldenGuilds(setConfig) {
  await setConfig(GOLDEN_GUILDS.es, { officerRoleId: 'officer-role', idioma: 'es' });
  await setConfig(GOLDEN_GUILDS.esRaffleRole, { officerRoleId: 'officer-role', idioma: 'es', raffleRoleId: 'raffle-role' });
  await setConfig(GOLDEN_GUILDS.en, { officerRoleId: 'officer-role', idioma: 'en' });
  await setConfig(GOLDEN_GUILDS.esRoleFilter, { officerRoleId: 'officer-role', idioma: 'es' });
}

/**
 * Los escenarios del golden. `extra` se mezcla en lo que el código nuevo
 * entiende (winners: 1 explícito, message: null...) para comprobar que no
 * cambia nada; el código viejo lo ignora.
 * @param {{ execute: Function, resolveRaffle: Function }} modules
 * @param {{ integers?: object, raffleExtra?: object }} [extra]
 */
let runCount = 0;

export async function runGoldenScenarios({ execute, resolveRaffle }, { integers = {}, raffleExtra = {} } = {}) {
  const out = {};
  // Canales nuevos en cada pasada: solo puede haber un sorteo activo por canal.
  const run = ++runCount;

  const announce = async (name, { guildId, role = null, locale }) => {
    const channel = new FakeChannel(`golden-${run}-${name}`);
    const interaction = makeInteraction({ guildId, channel, role, integers, locale });
    await withFrozenClock(() => execute(interaction));
    out[name] = { replies: interaction.replies.map(serialize), sent: channel.sent.map(serialize) };
  };

  await announce('announce.plain', { guildId: GOLDEN_GUILDS.es });
  await announce('announce.raffleRole', { guildId: GOLDEN_GUILDS.esRaffleRole });
  await announce('announce.restricted', { guildId: GOLDEN_GUILDS.esRaffleRole, role: { id: 'party-role' } });
  await announce('announce.en', { guildId: GOLDEN_GUILDS.en, locale: 'en-US' });

  const resolve = async (name, { guildId = GOLDEN_GUILDS.es, reactors, rolls, roleId = null, guild = null, delayed = false }) => {
    const channel = new FakeChannel(`golden-${run}-${name}`);
    const announcement = new FakeMessage(`${name}-announcement`, 'anuncio');
    if (reactors.length > 0) announcement.addReaction('🎉', reactors.map((id) => new FakeUser(id, id.startsWith('bot'))));
    channel.store.set(announcement.id, announcement);
    const client = makeClient({ channels: [channel], guilds: guild ? [guild] : [] });
    const raffle = {
      id: `raffle-${name}`,
      guildId,
      channelId: channel.id,
      messageId: announcement.id,
      endsAt: FIXED_NOW,
      creatorId: 'creator-1',
      roleId,
      ...raffleExtra,
    };
    await withRolls(rolls, () => resolveRaffle(client, raffle, { delayed }));
    out[name] = { sent: channel.sent.map(serialize) };
  };

  await resolve('result.distinct', { reactors: ['p1', 'p2', 'p3', 'p4'], rolls: [40, 90, 10, 70] });
  await resolve('result.topTie', { reactors: ['p1', 'p2', 'p3'], rolls: [80, 80, 20, 30, 60] });
  // Estos dos NO salen del código anterior (que no repetía el desempate y
  // decía siempre "segunda tirada"): se añadieron al corregir ese texto, y
  // fijan los dos textos nuevos de un ganador. El resto del golden sigue
  // siendo la salida de 6c5efae.
  await resolve('result.topTieTwice', { reactors: ['p1', 'p2', 'p3'], rolls: [80, 80, 20, 50, 50, 30, 70] });
  await resolve('result.topTieRandom', {
    reactors: ['p1', 'p2', 'p3'],
    rolls: [80, 80, 20, ...Array.from({ length: 10 }, () => [40, 40]).flat(), 0],
  });
  await resolve('result.lowerTie', { reactors: ['p1', 'p2', 'p3'], rolls: [99, 40, 40] });
  await resolve('result.many', { reactors: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'bot1'], rolls: [5, 15, 25, 35, 45, 55, 65] });
  await resolve('result.single', { reactors: ['p1'], rolls: [42] });
  await resolve('result.nobody', { reactors: [], rolls: [] });
  await resolve('result.delayed', { reactors: ['p1', 'p2'], rolls: [12, 34], delayed: true });
  await resolve('result.en', { guildId: GOLDEN_GUILDS.en, reactors: ['p1', 'p2'], rolls: [77, 33] });
  await resolve('result.roleFilter', {
    guildId: GOLDEN_GUILDS.esRoleFilter,
    roleId: 'party-role',
    guild: new FakeGuild(GOLDEN_GUILDS.esRoleFilter, { roleIds: ['party-role'], members: { p1: ['party-role'], p2: [], p3: ['party-role'] } }),
    reactors: ['p1', 'p2', 'p3'],
    rolls: [55, 66],
  });
  await resolve('result.roleFilterNobody', {
    guildId: GOLDEN_GUILDS.esRoleFilter,
    roleId: 'party-role',
    guild: new FakeGuild(GOLDEN_GUILDS.esRoleFilter, { roleIds: ['party-role'], members: { p1: [] } }),
    reactors: ['p1'],
    rolls: [],
  });

  return out;
}
