import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// isOfficer() lee officerRoleId del config.json del servidor: DATA_DIR
// temporal (fijado ANTES de importar nada que lo lea) con ese rol puesto.
const DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'sorteo-cmd-test-'));
process.env.DATA_DIR = DATA_DIR;
const GUILD_ID = '100000000000000001';

const { setConfig } = await import('../services/guildStore.js');
await setConfig(GUILD_ID, { officerRoleId: 'officer-role' });
after(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
});

const { execute } = await import('./sorteo.js');

function makeFakeInteraction({ rol }) {
  const replies = [];
  const channelSends = [];
  return {
    guildId: GUILD_ID,
    channelId: 'chan-1',
    member: { roles: { cache: new Map([['officer-role', true]]) } },
    user: { id: 'creator-1' },
    channel: {
      send: async (payload) => {
        channelSends.push(payload);
        return { id: 'msg-1', react: async () => {} };
      },
    },
    client: {},
    options: {
      getInteger: () => 30,
      getRole: () => rol,
    },
    reply: async (payload) => {
      replies.push(payload);
    },
    _replies: replies,
    _channelSends: channelSends,
  };
}

test('/sorteo: @everyone como rol se rechaza (equivale a no filtrar y confunde)', async () => {
  // El rol @everyone SIEMPRE tiene el mismo id que el guild.
  const everyoneRole = { id: GUILD_ID };
  const interaction = makeFakeInteraction({ rol: everyoneRole });

  await execute(interaction);

  assert.equal(interaction._replies.length, 1);
  const reply = interaction._replies[0];
  assert.equal(reply.ephemeral, true);
  assert.match(reply.embeds[0].toJSON().description, /@everyone/);
  assert.equal(interaction._channelSends.length, 0, 'no debe crear el sorteo ni publicar el anuncio');
});
