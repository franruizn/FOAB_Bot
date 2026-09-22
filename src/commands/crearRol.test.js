import { test } from 'node:test';
import assert from 'node:assert/strict';

// isOfficer() lee OFFICER_ROLE_ID de process.env en el momento de la
// llamada, así que basta con fijarlo antes de invocar execute().
process.env.OFFICER_ROLE_ID = 'officer-role';

const { execute } = await import('./crearRol.js');

function makeMember(id, username, { addFails = false } = {}) {
  const addCalls = [];
  let added = false;
  return {
    id,
    user: { username, bot: false },
    roles: {
      add: async (roleId, reason) => {
        addCalls.push({ roleId, reason });
        if (addFails) throw new Error('No se pudo asignar (forzado)');
        added = true;
      },
    },
    get _added() {
      return added;
    },
    _addCalls: addCalls,
  };
}

function makeGuild({ roleNames = [], members = new Map(), managerPermission = true, botPosition = 5 } = {}) {
  const createCalls = [];
  return {
    roles: {
      cache: {
        some: (fn) => roleNames.some((name) => fn({ name })),
        size: roleNames.length,
      },
      create: async (opts) => {
        createCalls.push(opts);
        return { id: 'new-role-id' };
      },
    },
    members: {
      fetch: async () => members,
      me: { permissions: { has: () => managerPermission }, roles: { highest: { position: botPosition } } },
    },
    _createCalls: createCalls,
  };
}

function makeButtonInteraction(customId) {
  const calls = [];
  return {
    customId,
    deferUpdate: async () => {
      calls.push({ type: 'deferUpdate' });
    },
    update: async (payload) => {
      calls.push({ type: 'update', payload });
    },
    editReply: async (payload) => {
      calls.push({ type: 'editReply', payload });
    },
    _calls: calls,
  };
}

function makeInteraction({ nombre, lista, guild, interactionId = 'inter-1', buttonInteraction = null }) {
  const replies = [];
  const editReplies = [];
  const fakeMessage = {
    awaitMessageComponent: async () => {
      if (!buttonInteraction) throw new Error('timeout (forzado, ningún botón preparado en el test)');
      return buttonInteraction;
    },
  };
  return {
    id: interactionId,
    user: { id: 'officer-1', tag: 'Officer#0001' },
    member: { roles: { cache: new Map([['officer-role', true]]) } },
    guild,
    options: {
      getString: (name) => (name === 'nombre' ? nombre : lista),
    },
    reply: async (payload) => {
      replies.push(payload);
    },
    editReply: async (payload) => {
      editReplies.push(payload);
      return fakeMessage;
    },
    _replies: replies,
    _editReplies: editReplies,
  };
}

test('/crear-rol: un nombre de rol que ya existe se rechaza sin crear nada', async () => {
  const guild = makeGuild({ roleNames: ['Ya Existe'] });
  const interaction = makeInteraction({ nombre: 'Ya Existe', lista: '@alguien', guild });

  await execute(interaction);

  assert.equal(interaction._replies.length, 1);
  assert.equal(interaction._replies[0].ephemeral, true);
  assert.match(interaction._replies[0].embeds[0].toJSON().description, /Ya hay un rol llamado/);
  assert.equal(guild._createCalls.length, 0);
  assert.equal(interaction._editReplies.length, 0, 'ni siquiera debe llegar a resolver la lista');
});

test('/crear-rol: sin el permiso "Gestionar roles", falla antes de crear el rol', async () => {
  const members = new Map([['1', makeMember('1', 'alguien')]]);
  const guild = makeGuild({ members, managerPermission: false });
  const interactionId = 'inter-perm';
  const buttonInteraction = makeButtonInteraction(`crear-rol-confirm-${interactionId}`);
  const interaction = makeInteraction({ nombre: 'Nuevo Rol', lista: '@alguien', guild, interactionId, buttonInteraction });

  await execute(interaction);

  assert.equal(guild._createCalls.length, 0, 'el rol nunca debe llegar a crearse');
  const finalCall = buttonInteraction._calls.at(-1);
  assert.equal(finalCall.type, 'editReply');
  assert.match(finalCall.payload.embeds[0].toJSON().description, /Gestionar roles/);
});

test('/crear-rol: si falla la asignación a una persona, las otras 24 la reciben y se reporta el fallo', async () => {
  const TOTAL = 25;
  const members = new Map();
  for (let i = 0; i < TOTAL; i++) {
    members.set(String(i), makeMember(String(i), `persona${i}`, { addFails: i === 12 }));
  }
  const guild = makeGuild({ members });
  const interactionId = 'inter-assign';
  const buttonInteraction = makeButtonInteraction(`crear-rol-confirm-${interactionId}`);
  const lista = Array.from({ length: TOTAL }, (_, i) => `@persona${i}`).join(' ');
  const interaction = makeInteraction({ nombre: 'Rol Masivo', lista, guild, interactionId, buttonInteraction });

  await execute(interaction);

  assert.equal(guild._createCalls.length, 1, 'el rol se crea una sola vez');

  const successfulAssignments = [...members.values()].filter((m) => m._added);
  assert.equal(successfulAssignments.length, TOTAL - 1);
  assert.equal(members.get('12')._added, false, 'la asignación que falla no queda marcada como éxito');
  assert.equal(members.get('12')._addCalls.length, 1, 'sí se intentó, solo que falló');

  const finalCall = buttonInteraction._calls.at(-1);
  assert.equal(finalCall.type, 'editReply');
  const description = finalCall.payload.embeds[0].toJSON().description;
  assert.match(description, /Asignado a \*\*24\*\* de 25/);
  assert.match(description, /<@12>/, 'menciona a quien falló la asignación');
});
