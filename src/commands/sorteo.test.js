import { test } from 'node:test';
import assert from 'node:assert/strict';

// isOfficer() lee OFFICER_ROLE_ID de process.env en el momento de la
// llamada (no del import), así que basta con fijarlo antes de invocar
// execute(); no hace falta el patrón de mkdtemp + DATA_DIR de
// raffleScheduler.test.js porque este caso vuelve pronto, antes de tocar
// raffles.json.
process.env.OFFICER_ROLE_ID = 'officer-role';

const { execute } = await import('./sorteo.js');

function makeFakeInteraction({ rol }) {
  const replies = [];
  const channelSends = [];
  return {
    guildId: 'guild-1',
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
  const everyoneRole = { id: 'guild-1' };
  const interaction = makeFakeInteraction({ rol: everyoneRole });

  await execute(interaction);

  assert.equal(interaction._replies.length, 1);
  const reply = interaction._replies[0];
  assert.equal(reply.ephemeral, true);
  assert.match(reply.embeds[0].toJSON().description, /@everyone/);
  assert.equal(interaction._channelSends.length, 0, 'no debe crear el sorteo ni publicar el anuncio');
});
