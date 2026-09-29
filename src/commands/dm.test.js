import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// DM_STATE_PATH se calcula al importar dataPaths.js: DATA_DIR tiene que
// estar fijado antes. DM_OWNER_ID / LOG_CHANNEL_ID se leen en cada llamada.
const DIR = await mkdtemp(path.join(os.tmpdir(), 'dm-cmd-test-'));
process.env.DATA_DIR = DIR;
process.env.LOG_CHANNEL_ID = 'log-chan';

const { DM_STATE_PATH } = await import('../dataPaths.js');
const { execute, __setDmSleepForTests } = await import('./dm.js');

__setDmSleepForTests(async () => {});

const OWNER = 'owner-1';
const GUILD_ID = 'guild-1';

after(async () => {
  await rm(DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  process.env.DM_OWNER_ID = OWNER;
  delete process.env.DM_OPTOUT_ROLE_ID;
  await rm(DM_STATE_PATH, { force: true });
});

function makeMember(id, username, { bot = false, roles = [] } = {}) {
  const received = [];
  return {
    id,
    user: { username, bot },
    roles: { cache: new Map(roles.map((r) => [r, true])) },
    send: async (payload) => {
      received.push(payload);
    },
    _received: received,
  };
}

function makeClient() {
  const logSends = [];
  return {
    channels: {
      fetch: async () => ({
        isTextBased: () => true,
        send: async (payload) => {
          logSends.push(payload);
        },
      }),
    },
    _logSends: logSends,
  };
}

function makeInteraction({ userId = OWNER, rol = null, lista = null, members = new Map(), body = 'hola', confirm = true } = {}) {
  const replies = [];
  const modals = [];
  const channelSends = [];
  const progressEdits = [];
  const modalReplies = [];
  const buttonCalls = [];
  const client = makeClient();
  const id = `inter-${Math.random().toString(36).slice(2)}`;

  const buttonInteraction = {
    customId: confirm ? `dm-confirm-${id}` : `dm-cancel-${id}`,
    user: { id: userId },
    deferUpdate: async () => buttonCalls.push({ type: 'deferUpdate' }),
    update: async (payload) => buttonCalls.push({ type: 'update', payload }),
    editReply: async (payload) => buttonCalls.push({ type: 'editReply', payload }),
  };

  const modalInteraction = {
    customId: `dm-modal-${id}`,
    user: { id: userId },
    fields: { getTextInputValue: () => body },
    reply: async (payload) => modalReplies.push({ type: 'reply', payload }),
    deferReply: async (payload) => modalReplies.push({ type: 'deferReply', payload }),
    editReply: async (payload) => {
      modalReplies.push({ type: 'editReply', payload });
      return {
        awaitMessageComponent: async ({ filter }) => {
          assert.ok(filter(buttonInteraction), 'el botón lo pulsa el dueño');
          return buttonInteraction;
        },
      };
    },
  };

  const interaction = {
    id,
    client,
    user: { id: userId, tag: `${userId}#0001`, username: userId },
    member: { displayName: 'Remitente' },
    guild: {
      id: GUILD_ID,
      name: 'FOAB',
      members: { cache: new Map(), fetch: async () => members },
    },
    channel: {
      send: async (payload) => {
        channelSends.push(payload);
        return { edit: async (edit) => progressEdits.push(edit) };
      },
    },
    options: { getRole: () => rol, getString: () => lista },
    reply: async (payload) => replies.push(payload),
    showModal: async (modal) => modals.push(modal),
    awaitModalSubmit: async ({ filter }) => {
      assert.ok(filter(modalInteraction));
      return modalInteraction;
    },
    _replies: replies,
    _modals: modals,
    _modalReplies: modalReplies,
    _buttonCalls: buttonCalls,
    _channelSends: channelSends,
    _progressEdits: progressEdits,
  };
  return interaction;
}

const embedText = (payload) => payload.embeds.map((e) => JSON.stringify(e.toJSON())).join('\n');

test('/dm: un usuario que no es DM_OWNER_ID se rechaza y el intento queda registrado', async () => {
  const members = new Map([['1', makeMember('1', 'uno')]]);
  const interaction = makeInteraction({ userId: 'intruso-9', lista: '@uno', members });

  await execute(interaction);

  assert.equal(interaction._replies.length, 1);
  assert.equal(interaction._replies[0].ephemeral, true);
  assert.match(embedText(interaction._replies[0]), /Sin permiso/);
  assert.equal(interaction._modals.length, 0, 'ni siquiera abre el modal');
  assert.equal(members.get('1')._received.length, 0);

  assert.equal(interaction.client._logSends.length, 1);
  assert.match(embedText(interaction.client._logSends[0]), /intruso-9/);
});

test('/dm: con DM_OWNER_ID vacío el comando está desactivado (falla cerrado)', async () => {
  process.env.DM_OWNER_ID = '   ';
  const interaction = makeInteraction({ userId: '', lista: '@uno' });

  await execute(interaction);

  assert.equal(interaction._replies.length, 1);
  assert.match(embedText(interaction._replies[0]), /desactivado/);
  assert.equal(interaction._modals.length, 0);
});

test('/dm: @everyone como rol se rechaza', async () => {
  const interaction = makeInteraction({ rol: { id: GUILD_ID } });

  await execute(interaction);

  assert.match(embedText(interaction._replies[0]), /@everyone/);
  assert.equal(interaction._modals.length, 0);
});

test('/dm: 201 destinatarios se rechaza sin enviar nada', async () => {
  const members = new Map();
  for (let i = 0; i < 201; i++) members.set(String(i), makeMember(String(i), `p${i}`, { roles: ['grupo'] }));
  const interaction = makeInteraction({ rol: { id: 'grupo' }, members });

  await execute(interaction);

  const last = interaction._modalReplies.at(-1);
  assert.equal(last.type, 'editReply');
  assert.match(embedText(last.payload), /Son 201 y el tope de \/dm es 200/);
  assert.ok([...members.values()].every((m) => m._received.length === 0));
  assert.equal(interaction._channelSends.length, 0);
});

test('/dm: 200 destinatarios exactos sí se permite', async () => {
  const members = new Map();
  for (let i = 0; i < 200; i++) members.set(String(i), makeMember(String(i), `p${i}`));
  const lista = [...members.values()].map((m) => `@${m.user.username}`).join(' ');
  const interaction = makeInteraction({ lista, members });

  await execute(interaction);

  assert.ok([...members.values()].every((m) => m._received.length === 1));
  // 200 procesados: ediciones de progreso en 25..175 (7) + el resultado final.
  assert.equal(interaction._progressEdits.length, 8);
});

test('/dm: lista con <@id> y @nombre mezclados resuelve ambos; bots saltados; cabecera fija', async () => {
  const members = new Map([
    ['111', makeMember('111', 'uno')],
    ['222', makeMember('222', 'dos')],
    ['333', makeMember('333', 'robot', { bot: true })],
  ]);
  const interaction = makeInteraction({ lista: '<@111>, @dos @robot @noexiste', members, body: 'Mensaje de prueba' });

  await execute(interaction);

  const expected = '📨 Remitente te envía este mensaje desde **FOAB**:\n\nMensaje de prueba';
  assert.deepEqual(members.get('111')._received.map((p) => p.content), [expected]);
  assert.deepEqual(members.get('222')._received.map((p) => p.content), [expected]);
  assert.equal(members.get('333')._received.length, 0, 'los bots no reciben nada');

  // La previsualización muestra el mensaje EXACTO y a quién no se resolvió.
  const preview = interaction._modalReplies.find((r) => r.type === 'editReply' && r.payload.components?.length);
  assert.equal(preview.payload.content, expected);
  assert.match(embedText(preview.payload), /Destinatarios: \*\*2\*\*/);
  assert.match(embedText(preview.payload), /@noexiste/);

  // Resultado en el canal (no solo ephemeral) y rastro en el canal de logs.
  const finalEdit = interaction._progressEdits.at(-1);
  assert.match(embedText(finalEdit), /Recibieron el mensaje: \*\*2\*\*/);
  assert.match(embedText(finalEdit), /@noexiste/);
  const logs = interaction.client._logSends.map(embedText).join('\n');
  assert.match(logs, /envío iniciado/);
  assert.match(logs, /Mensaje de prueba/);
  assert.match(logs, /envío terminado/);
});

test('/dm: con rol, un destinatario con DMs cerrados y otro con el rol de exclusión se reportan', async () => {
  process.env.DM_OPTOUT_ROLE_ID = 'optout';
  const cerrado = makeMember('2', 'dos', { roles: ['grupo'] });
  cerrado.send = async () => {
    throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
  };
  const members = new Map([
    ['1', makeMember('1', 'uno', { roles: ['grupo'] })],
    ['2', cerrado],
    ['3', makeMember('3', 'tres', { roles: ['grupo', 'optout'] })],
    ['4', makeMember('4', 'bot', { roles: ['grupo'], bot: true })],
    ['5', makeMember('5', 'fuera')],
  ]);
  const interaction = makeInteraction({ rol: { id: 'grupo' }, members });

  await execute(interaction);

  assert.equal(members.get('1')._received.length, 1);
  assert.equal(members.get('3')._received.length, 0);
  assert.equal(members.get('4')._received.length, 0);
  assert.equal(members.get('5')._received.length, 0);

  const result = embedText(interaction._progressEdits.at(-1));
  assert.match(result, /Recibieron el mensaje: \*\*1\*\*/);
  assert.match(result, /DMs cerrados \(\*\*1\*\*\): <@2>/);
  assert.match(result, /rol de exclusión \(\*\*1\*\*\): <@3>/);
  assert.match(result, /Bots saltados: \*\*1\*\*/);
});

test('/dm: un segundo /dm antes de 10 minutos se rechaza por cooldown', async () => {
  const members = new Map([['1', makeMember('1', 'uno')]]);
  await execute(makeInteraction({ lista: '@uno', members }));
  assert.equal(members.get('1')._received.length, 1);

  const second = makeInteraction({ lista: '@uno', members });
  await execute(second);

  assert.match(embedText(second._replies[0]), /un \/dm cada 10 minutos/);
  assert.equal(second._modals.length, 0);
  assert.equal(members.get('1')._received.length, 1, 'no se envía otra vez');
});

test('/dm: cancelar no envía nada ni consume el cooldown', async () => {
  const members = new Map([['1', makeMember('1', 'uno')]]);
  const cancelled = makeInteraction({ lista: '@uno', members, confirm: false });
  await execute(cancelled);
  assert.equal(members.get('1')._received.length, 0);
  assert.equal(cancelled._buttonCalls.at(-1).type, 'update');

  await execute(makeInteraction({ lista: '@uno', members }));
  assert.equal(members.get('1')._received.length, 1);
});
