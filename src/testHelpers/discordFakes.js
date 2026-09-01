// Dobles en memoria de discord.js para los tests permanentes de /cta. Solo
// implementan lo que el código de producción realmente llama (duck typing),
// no una reimplementación general de la API de discord.js. Vive fuera de
// **/*.test.js a propósito: no es un test en sí, es una fixture compartida
// por varios test files (ctaRole.test.js, cta.test.js) — así el doble de
// Guild/Member/Role tiene una sola versión, no una por fichero.

let nextRoleId = 1;
let nextMessageId = 1;

export class FakeRole {
  constructor(guild, { id, name, mentionable, hoist, reason, position, createdTimestamp }) {
    this.guild = guild;
    this.id = id;
    this.name = name;
    this.mentionable = mentionable;
    this.hoist = hoist;
    this.reason = reason;
    this.position = position;
    this.createdTimestamp = createdTimestamp ?? Date.now();
  }
  get members() {
    const map = new Map();
    for (const member of this.guild.members.cache.values()) {
      if (member.roles.cache.has(this.id)) map.set(member.id, member);
    }
    return map;
  }
}

class FakeRoleManager {
  constructor(guild) {
    this.guild = guild;
    this.cache = new Map();
  }
  async create({ name, mentionable, hoist, reason }) {
    if (this.guild.__forceCreateFail) throw new Error(this.guild.__forceCreateFail);
    const id = `role-${nextRoleId++}`;
    const role = new FakeRole(this.guild, { id, name, mentionable, hoist, reason, position: 1 });
    this.cache.set(id, role);
    return role;
  }
  async delete(roleId) {
    this.cache.delete(roleId);
  }
  async fetch(roleId) {
    return this.cache.get(roleId) ?? null;
  }
}

class FakeMemberRoles {
  constructor(member) {
    this.member = member;
    this.cache = new Map();
    this.highest = { position: 5 }; // sobreescribible por escenario (jerarquía del bot)
  }
  has(roleId) {
    return this.cache.has(roleId);
  }
  async add(roleId) {
    if (this.member.guild.__forceRoleOpFail?.has(this.member.id)) throw new Error('Missing Permissions (forzado)');
    const role = this.member.guild.roles.cache.get(roleId);
    this.cache.set(roleId, role);
  }
  async remove(roleId) {
    if (this.member.guild.__forceRoleOpFail?.has(this.member.id)) throw new Error('Missing Permissions (forzado)');
    this.cache.delete(roleId);
  }
}

export class FakeMember {
  constructor(guild, id, tag) {
    this.guild = guild;
    this.id = id;
    this.user = { id, tag, username: tag };
    this.displayName = tag;
    this.roles = new FakeMemberRoles(this);
    this.permissions = { has: () => this.guild.__botHasManageRoles !== false };
  }
}

class FakeGuildMemberManager {
  constructor(guild) {
    this.guild = guild;
    this.cache = new Map();
  }
  async fetch(id) {
    if (id) {
      const m = this.cache.get(id);
      if (!m) throw new Error('Unknown Member');
      return m;
    }
    return this.cache; // "fetch all": en este doble la caché ya está completa de antemano
  }
}

export class FakeGuild {
  constructor(id = 'guild-1') {
    this.id = id;
    this.roles = new FakeRoleManager(this);
    this.members = new FakeGuildMemberManager(this);
    this.client = { user: { id: 'bot-1' } };
    this.__botHasManageRoles = true;
    this.__forceRoleOpFail = new Set();
  }
  addMember(id, tag) {
    const member = new FakeMember(this, id, tag);
    this.members.cache.set(id, member);
    return member;
  }
  addFillerRoles(count, { position = 2 } = {}) {
    for (let i = 0; i < count; i++) {
      const id = `filler-${nextRoleId++}`;
      this.roles.cache.set(id, new FakeRole(this, { id, name: `filler-${i}`, position }));
    }
  }
}

export class FakeMessage {
  constructor(payload) {
    this.id = String(nextMessageId++);
    this.deleted = false;
    this._apply(payload);
  }
  _apply(payload) {
    if (payload?.embeds) this.embeds = payload.embeds.map((e) => (typeof e.toJSON === 'function' ? e.toJSON() : e));
    if (payload?.components) this.components = payload.components;
  }
  async edit(payload) {
    this._apply(payload);
  }
  async delete() {
    this.deleted = true;
  }
}

export class FakeChannel {
  constructor(id) {
    this.id = id;
    this.store = new Map();
    this.sentPayloads = [];
    this.isTextBased = () => true;
    this.__forceSendFail = false;
    this.messages = {
      fetch: async (msgId) => this.store.get(msgId) ?? Promise.reject(new Error(`Unknown Message ${msgId}`)),
    };
  }
  async send(payload) {
    if (this.__forceSendFail) throw new Error('No se pudo enviar el mensaje (forzado)');
    const msg = new FakeMessage(payload);
    this.store.set(msg.id, msg);
    this.sentPayloads.push(payload);
    return msg;
  }
}

export function makeFakeClient(channelsById) {
  return {
    channels: {
      fetch: async (id) => channelsById.get(id) ?? Promise.reject(new Error(`unknown channel ${id}`)),
    },
  };
}

export class FakeChatInputInteraction {
  constructor({ channelId, channel, guild, member, opts = {}, subcommand, client }) {
    this.channelId = channelId;
    this.guildId = guild.id;
    this.guild = guild;
    this.channel = channel;
    this.client = client;
    this.user = member.user;
    this.member = member;
    this.options = {
      getSubcommand: () => subcommand,
      getInteger: (name) => opts[name] ?? null,
      getString: (name) => opts[name] ?? null,
    };
    this.replies = [];
    this.followUps = [];
    this.editReplies = [];
    this.deferred = false;
  }
  async reply(p) {
    this.replies.push(p);
    return new FakeMessage(p);
  }
  async followUp(p) {
    this.followUps.push(p);
    return new FakeMessage(p);
  }
  async deferReply() {
    this.deferred = true;
  }
  async editReply(p) {
    this.editReplies.push(p);
  }
  /** Último texto/embed producido, sea por reply/followUp/editReply (en ese orden de "más reciente real"). */
  lastEvent() {
    const events = [
      ...this.replies.map((p) => ({ p, kind: 'reply' })),
      ...this.followUps.map((p) => ({ p, kind: 'followUp' })),
      ...this.editReplies.map((p) => ({ p, kind: 'editReply' })),
    ];
    return events.at(-1)?.p;
  }
  lastContent() {
    return (this.editReplies.at(-1) ?? this.followUps.at(-1) ?? this.replies.at(-1))?.content;
  }
}

export class FakeModalSubmitInteraction {
  constructor({ customId, member, fieldValues, client }) {
    this.customId = customId;
    this.user = member.user;
    this.member = member;
    this.guild = member.guild;
    this.client = client;
    this.editReplies = [];
    this.deferred = false;
    this.fields = { getTextInputValue: (id) => fieldValues[id] ?? '' };
  }
  async deferReply() {
    this.deferred = true;
  }
  async editReply(p) {
    this.editReplies.push(p);
  }
  lastContent() {
    return this.editReplies.at(-1)?.content;
  }
}

export class FakeButtonInteraction {
  constructor({ customId, member, client }) {
    this.customId = customId;
    this.user = member.user;
    this.member = member;
    this.guild = member.guild;
    this.client = client;
    this.editReplies = [];
    this.followUps = [];
    this.modalsShown = [];
    this.deferred = false;
  }
  async showModal(modal) {
    this.modalsShown.push(modal);
  }
  async deferReply() {
    this.deferred = true;
  }
  async editReply(p) {
    this.editReplies.push(p);
  }
  async followUp(p) {
    this.followUps.push(p);
  }
  lastContent() {
    return this.editReplies.at(-1)?.content;
  }
}
