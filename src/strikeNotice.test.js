import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'strike-notice-test-'));
process.env.DATA_DIR = DATA_DIR;

const { PermissionFlagsBits, ChannelType } = await import('discord.js');
const { setConfig, getConfig } = await import('./services/guildStore.js');
const { addStrike, loadStrikes, activeStrikes } = await import('./services/strikesStore.js');
const { execute } = await import('./commands/strike.js');
const { execute: executeConfig } = await import('./commands/config.js');

after(() => rm(DATA_DIR, { recursive: true, force: true, maxRetries: 5 }));

const OFFICER = '100000000000000001';
const TARGET = '100000000000000002';
const RED = 0xed4245;
const GREEN = 0x57f287;

let nextGuild = 930000000000000000n;
const newGuildId = () => String(++nextGuild);
const logOf = (guildId) => `log-${guildId}`;
const publicOf = (guildId) => `public-${guildId}`;

async function newGuild(extra = {}) {
  const guildId = newGuildId();
  await setConfig(guildId, {
    officerRoleId: `role-${guildId}`,
    logChannelId: logOf(guildId),
    strikeChannelId: publicOf(guildId),
    idioma: 'es',
    ...extra,
  });
  return guildId;
}

/** Cliente con todos los canales válidos salvo los de `broken`. */
function clientDouble({ broken = {} } = {}) {
  const sent = [];
  return {
    sent,
    channels: {
      fetch: async (channelId) => {
        if (broken[channelId] === 'missing') throw new Error('Unknown Channel');
        return {
          id: channelId,
          guildId: broken[channelId]?.ownerGuild ?? channelId.replace(/^(log|public)-/, ''),
          isTextBased: () => true,
          send: async (payload) => {
            if (broken[channelId] === 'forbidden') throw new Error('Missing Permissions');
            sent.push({ channelId, payload });
          },
        };
      },
    },
  };
}

let nextInteraction = 1;

function strike(guildId, sub, { reason = null, client = clientDouble(), member = {}, failEdit = false } = {}) {
  const id = String(nextInteraction++);
  const replies = [];
  const responder = async (payload) => {
    if (failEdit) throw new Error('Unknown Webhook');
    replies.push(payload);
    return message;
  };
  const message = {
    awaitMessageComponent: async () => ({
      customId: `strike-clear-confirm-${id}`,
      user: { id: OFFICER },
      deferUpdate: async () => {},
      update: responder,
      editReply: responder,
    }),
  };
  return {
    id,
    guildId,
    guild: { id: guildId, roles: { cache: new Map([[`role-${guildId}`, {}]]) }, members: { cache: new Map() } },
    locale: 'es-ES',
    client,
    user: { id: OFFICER, username: 'oficial', tag: 'oficial' },
    member: { roles: { cache: new Map([[`role-${guildId}`, {}]]) } },
    options: {
      getSubcommand: () => sub,
      getUser: () => ({ id: TARGET, username: 'afectado', tag: 'afectado', bot: false }),
      getString: () => reason,
      getMember: () => (member === null ? null : { id: TARGET, displayName: 'Apodo', ...member }),
    },
    replies,
    reply: responder,
    deferReply: async () => {},
    editReply: responder,
  };
}

async function until(condition, ms = 2000) {
  const start = performance.now();
  while (performance.now() - start < ms) {
    if (condition()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return false;
}

const seed = (guildId, reason = 'motivo') => addStrike(guildId, { userId: TARGET, userName: 'Apodo', reason, addedBy: OFFICER });
const inChannel = (client, channelId) => client.sent.filter((entry) => entry.channelId === channelId);

async function publicNotice(guildId, sub, options = {}) {
  const client = options.client ?? clientDouble();
  await execute(strike(guildId, sub, { ...options, client }));
  assert.ok(await until(() => inChannel(client, publicOf(guildId)).length === 1), 'llega el aviso público');
  const { payload } = inChannel(client, publicOf(guildId))[0];
  return { client, payload, embed: payload.embeds[0].toJSON() };
}

// --- contenido ---

test('add: embed rojo en el canal configurado, con motivo, oficial y total', async () => {
  const g = await newGuild();
  await seed(g);
  await seed(g);
  const { embed } = await publicNotice(g, 'add', { reason: 'No apareció a la ZvZ del martes' });
  assert.equal(embed.color, RED);
  assert.equal(embed.title, '⚠️ Nuevo strike');
  assert.deepEqual(embed.description.split('\n'), [
    `👤 <@${TARGET}>`,
    '📝 **Motivo:** No apareció a la ZvZ del martes',
    `🛡️ **Puesto por:** <@${OFFICER}>`,
    '📊 **Total:** 3 strikes activos',
  ]);
});

test('add: con un solo strike el total va en singular', async () => {
  const g = await newGuild();
  const { embed } = await publicNotice(g, 'add', { reason: 'x' });
  assert.match(embed.description, /\*\*Total:\*\* 1 strike activo$/);
});

test('remove: embed verde con el motivo original, su fecha y el de la retirada', async () => {
  const g = await newGuild();
  await seed(g, 'se queda');
  const { strike: original } = await seed(g, 'No apareció a la ZvZ');
  const { embed } = await publicNotice(g, 'remove', { reason: 'Estaba justificado' });
  const unix = Math.floor(Date.parse(original.addedAt) / 1000);
  assert.equal(embed.color, GREEN);
  assert.equal(embed.title, '✅ Strike retirado');
  assert.deepEqual(embed.description.split('\n'), [
    `👤 <@${TARGET}>`,
    `🗒️ **Strike retirado:** No apareció a la ZvZ · <t:${unix}:R>`,
    '📝 **Motivo:** Estaba justificado',
    `🛡️ **Retirado por:** <@${OFFICER}>`,
    '📊 **Total:** 1 strike activo',
  ]);
});

test('remove sin motivo: no sale la línea ni queda una vacía', async () => {
  const g = await newGuild();
  await seed(g, 'original');
  const { embed } = await publicNotice(g, 'remove');
  const lines = embed.description.split('\n');
  assert.equal(lines.length, 4);
  assert.ok(lines.every((line) => line.trim().length > 0));
  assert.doesNotMatch(embed.description, /📝|Motivo:|ninguno|null|undefined/);
  assert.match(embed.description, /original/);
});

test('clear: dice cuántos se retiraron y deja el total en 0', async () => {
  const g = await newGuild();
  for (let n = 0; n < 4; n++) await seed(g);
  const { embed } = await publicNotice(g, 'clear');
  assert.equal(embed.color, GREEN);
  assert.equal(embed.title, '🧹 Strikes limpiados');
  assert.deepEqual(embed.description.split('\n'), [
    `👤 <@${TARGET}>`,
    '🗑️ Se han retirado **4 strikes**',
    `🛡️ **Por:** <@${OFFICER}>`,
    '📊 **Total:** 0 strikes activos',
  ]);
});

test('un motivo con guiones bajos y asteriscos no rompe el formato', async () => {
  const g = await newGuild();
  const { embed } = await publicNotice(g, 'add', { reason: 'no_vino **nunca** a *la* ZvZ' });
  assert.ok(embed.description.includes('no\\_vino \\*\\*nunca\\*\\* a \\*la\\* ZvZ'));

  await seed(g, 'otro_motivo *x*');
  const removed = await publicNotice(g, 'remove', { reason: 'mal_puesto' });
  assert.ok(removed.embed.description.includes('otro\\_motivo \\*x\\*'));
  assert.ok(removed.embed.description.includes('mal\\_puesto'));
});

// --- menciones ---

for (const [sub, reason] of [['add', 'x'], ['remove', 'y'], ['clear', null]]) {
  test(`${sub}: solo se notifica al afectado, y la mención va donde Discord la notifica`, async () => {
    const g = await newGuild();
    if (sub !== 'add') await seed(g);
    const { payload, embed } = await publicNotice(g, sub, { reason });
    assert.deepEqual(payload.allowedMentions, { users: [TARGET] });
    // Una mención dentro de un embed no notifica: tiene que estar en content.
    assert.equal(payload.content, `<@${TARGET}>`);
    assert.ok(embed.description.includes(`<@${OFFICER}>`), 'el oficial sale, pero sin notificación');
  });
}

test('un motivo con @everyone o una mención no notifica a nadie más', async () => {
  const g = await newGuild();
  const { payload } = await publicNotice(g, 'add', { reason: `@everyone <@&123456789012345678> <@${OFFICER}>` });
  assert.deepEqual(payload.allowedMentions, { users: [TARGET] });
  assert.equal(payload.content, `<@${TARGET}>`);
});

test('a quien ya se fue se le nombra con su apodo y no se le menciona', async () => {
  const g = await newGuild();
  await seed(g);
  const { payload, embed } = await publicNotice(g, 'add', { reason: 'x', member: null });
  assert.equal(payload.content, undefined);
  assert.match(embed.description, /Apodo \*\(se fue del servidor\)\*/);
});

// --- canales ---

test('el aviso a logs sigue saliendo, sin ping, además del público', async () => {
  const g = await newGuild();
  const client = clientDouble();
  await execute(strike(g, 'add', { reason: 'x', client }));
  assert.ok(await until(() => client.sent.length === 2));
  assert.deepEqual(inChannel(client, logOf(g))[0].payload.allowedMentions, { parse: [] });
});

test('sin strikeChannelId no se publica nada y el comando funciona igual', async () => {
  const g = await newGuild({ strikeChannelId: null });
  const client = clientDouble();
  const i = strike(g, 'add', { reason: 'x', client });
  await execute(i);
  assert.ok(await until(() => client.sent.length === 1));
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].channelId, logOf(g));
  assert.equal(i.replies.length, 1);
  assert.equal((await loadStrikes(g)).length, 1);
});

test('strikeChannelId == logChannelId: un solo mensaje, el público', async () => {
  const g = newGuildId();
  await setConfig(g, { officerRoleId: `role-${g}`, logChannelId: publicOf(g), strikeChannelId: publicOf(g), idioma: 'es' });
  const client = clientDouble();
  await execute(strike(g, 'add', { reason: 'x', client }));
  assert.ok(await until(() => client.sent.length >= 1));
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(client.sent.length, 1);
  assert.deepEqual(client.sent[0].payload.allowedMentions, { users: [TARGET] });
});

for (const [name, failure] of [['no existe', 'missing'], ['no tiene permisos', 'forbidden']]) {
  for (const sub of ['add', 'remove', 'clear']) {
    test(`${sub}: si el canal ${name}, se guarda igual, logs sale y la respuesta lo dice`, async (t) => {
      const error = mock.method(console, 'error', () => {});
      t.after(() => error.mock.restore());
      const g = await newGuild();
      if (sub !== 'add') await seed(g);
      const client = clientDouble({ broken: { [publicOf(g)]: failure } });
      const i = strike(g, sub, { reason: sub === 'clear' ? null : 'x', client });
      await execute(i);

      assert.equal(activeStrikes(await loadStrikes(g), TARGET).length, sub === 'add' ? 1 : 0);
      assert.ok(await until(() => i.replies.some((p) => p.content?.includes(`<#${publicOf(g)}>`))), 'avisa al oficial');
      const warning = i.replies.find((p) => p.content?.includes(`<#${publicOf(g)}>`));
      assert.match(warning.content, /se ha guardado, pero no se pudo avisar/);
      assert.equal(warning.embeds, undefined, 'conserva el embed de la respuesta');
      assert.deepEqual(warning.allowedMentions, { parse: [] });
      assert.ok(i.replies[0].embeds?.length, 'la respuesta normal llega primero');
      assert.ok(await until(() => inChannel(client, logOf(g)).length === 1));
    });
  }
}

test('si falla la respuesta Y el aviso público, no revienta y el strike sigue guardado', async (t) => {
  const error = mock.method(console, 'error', () => {});
  t.after(() => error.mock.restore());
  const g = await newGuild();
  const client = clientDouble({ broken: { [publicOf(g)]: 'missing' } });
  await execute(strike(g, 'add', { reason: 'x', client, failEdit: true }));
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal((await loadStrikes(g)).length, 1);
});

// --- aislamiento ---

test('aislamiento: el canal de A no recibe los strikes de B', async () => {
  const [a, b] = [await newGuild(), await newGuild()];
  const client = clientDouble();
  await execute(strike(b, 'add', { reason: 'solo en B', client }));
  assert.ok(await until(() => client.sent.length === 2));
  assert.equal(inChannel(client, publicOf(a)).length, 0);
  assert.equal(inChannel(client, publicOf(b)).length, 1);
});

test('aislamiento: un id de canal de otro servidor no se publica y se avisa al oficial', async (t) => {
  const error = mock.method(console, 'error', () => {});
  t.after(() => error.mock.restore());
  const [a, b] = [await newGuild(), newGuildId()];
  await setConfig(b, { officerRoleId: `role-${b}`, logChannelId: logOf(b), strikeChannelId: publicOf(a), idioma: 'es' });
  const client = clientDouble();
  const i = strike(b, 'add', { reason: 'x', client });
  await execute(i);
  assert.ok(await until(() => i.replies.some((p) => p.content?.includes('no se pudo avisar'))));
  assert.equal(inChannel(client, publicOf(a)).length, 0);
});

// --- /config strike-channel ---

function configInteraction(guildId, options, channels = new Map()) {
  const edits = [];
  return {
    guildId,
    guild: {
      preferredLocale: 'es-ES',
      roles: { cache: new Map() },
      channels: { cache: channels, fetch: async (id) => channels.get(id) ?? null },
      members: { me: { id: 'bot' } },
    },
    locale: 'es-ES',
    user: { id: OFFICER, tag: 'Admin#0001' },
    memberPermissions: { has: (flag) => flag === PermissionFlagsBits.Administrator },
    client: clientDouble(),
    options: {
      getSubcommand: () => 'strike-channel',
      getChannel: (name) => options[name] ?? null,
      getBoolean: (name) => options[name] ?? null,
      getString: () => null,
    },
    reply: async () => {},
    deferReply: async () => {},
    editReply: async (payload) => edits.push(payload),
    edits,
  };
}

const textChannel = (id, granted = () => true, type = ChannelType.GuildText) => ({ id, type, permissionsFor: () => ({ has: granted }) });
const SAVED = '500000000000000010';

test('/config strike-channel: por defecto null; guarda el canal y off lo quita', async () => {
  const g = newGuildId();
  assert.equal((await getConfig(g)).strikeChannelId, null);
  await executeConfig(configInteraction(g, { channel: { id: SAVED } }, new Map([[SAVED, textChannel(SAVED)]])));
  assert.equal((await getConfig(g)).strikeChannelId, SAVED);
  await executeConfig(configInteraction(g, { off: true }));
  assert.equal((await getConfig(g)).strikeChannelId, null);
});

test('/config strike-channel: exige poder escribir e insertar embeds, y no guarda si no', async () => {
  for (const missing of [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]) {
    const g = newGuildId();
    const channel = textChannel(SAVED, (flag) => flag !== missing);
    const i = configInteraction(g, { channel: { id: SAVED } }, new Map([[SAVED, channel]]));
    await executeConfig(i);
    assert.equal((await getConfig(g)).strikeChannelId, null);
    assert.match(i.edits[0].embeds[0].toJSON().description, /No puedo escribir/);
  }
});

test('/config strike-channel: no necesita adjuntar ficheros', async () => {
  const g = newGuildId();
  const channel = textChannel(SAVED, (flag) => flag !== PermissionFlagsBits.AttachFiles);
  await executeConfig(configInteraction(g, { channel: { id: SAVED } }, new Map([[SAVED, channel]])));
  assert.equal((await getConfig(g)).strikeChannelId, SAVED);
});

test('/config strike-channel: rechaza un canal de voz, nada elegido, o canal y off a la vez', async () => {
  const voice = textChannel(SAVED, () => true, ChannelType.GuildVoice);
  for (const options of [{ channel: { id: SAVED } }, {}, { channel: { id: SAVED }, off: true }, { off: false }]) {
    const g = newGuildId();
    const i = configInteraction(g, options, new Map([[SAVED, voice]]));
    await executeConfig(i);
    assert.equal((await getConfig(g)).strikeChannelId, null);
    assert.equal(i.edits[0].embeds[0].toJSON().color, RED);
  }
});

test('/config strike-channel: avisa si es el mismo canal que el de logs', async () => {
  const g = newGuildId();
  await setConfig(g, { logChannelId: SAVED });
  const i = configInteraction(g, { channel: { id: SAVED } }, new Map([[SAVED, textChannel(SAVED)]]));
  await executeConfig(i);
  assert.match(i.edits[0].embeds[0].toJSON().description, /solo saldrá el aviso público/);
});
