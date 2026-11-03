import { test, after, mock } from 'node:test';
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
await setConfig(GUILD_ID, { officerRoleId: 'officer-role', idioma: 'es' });
after(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
});

const { execute, normalizeRaffleMessage } = await import('./sorteo.js');
const { loadRaffles } = await import('../services/rafflesStore.js');

function makeFakeInteraction({ rol = null, channelId = 'chan-1', integers = {}, strings = {} } = {}) {
  const replies = [];
  const channelSends = [];
  return {
    guildId: GUILD_ID,
    locale: 'es-ES',
    channelId,
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
      getInteger: (name) => ({ minutes: 30, ...integers })[name] ?? null,
      getString: (name) => strings[name] ?? null,
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

// Los casos que SÍ crean el sorteo dejarían un setTimeout de 30 minutos
// vivo (scheduleRaffleResolution): con los timers simulados no se dispara y
// no retiene el proceso de los tests.
async function executeCreating(interaction, t) {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  await execute(interaction);
}

test('/sorteo sin ganadores ni mensaje: el anuncio es el de siempre y se guarda 1 ganador sin mensaje', async (t) => {
  const interaction = makeFakeInteraction({ channelId: 'chan-default' });
  await executeCreating(interaction, t);

  const [announcement] = interaction._channelSends;
  assert.match(announcement.content, /^<@creator-1> ha comenzado un sorteo que terminará <t:\d+:R>\.\n\nReacciona con 🎉 para participar\.$/);
  const stored = (await loadRaffles(GUILD_ID)).find((r) => r.channelId === 'chan-default');
  assert.equal(stored.winners, 1);
  assert.equal(stored.message, null);
});

test('/sorteo con mensaje y ganadores: el mensaje va en su propio embed, los ganadores en el texto, y se persiste', async (t) => {
  const interaction = makeFakeInteraction({
    channelId: 'chan-msg',
    integers: { winners: 3 },
    // Tal como llega de Discord: una barra y una n, no un salto de línea.
    strings: { message: 'Premio: **montura T8**\\nSuerte a todos' },
  });
  await executeCreating(interaction, t);

  const [announcement] = interaction._channelSends;
  assert.match(announcement.content, /terminará <t:\d+:R>\.\n\n🏆 \*\*3 ganadores\*\*\n\nReacciona con 🎉 para participar\.$/);
  assert.deepEqual(announcement.embeds.map((e) => e.toJSON().fields), [[{ name: 'Mensaje', value: 'Premio: **montura T8**\nSuerte a todos' }]]);
  const stored = (await loadRaffles(GUILD_ID)).find((r) => r.channelId === 'chan-msg');
  assert.equal(stored.winners, 3);
  assert.equal(stored.message, 'Premio: **montura T8**\nSuerte a todos');
});

test('/sorteo: el mensaje no puede pingar (@everyone, @here ni roles), solo el rol del sorteo', async (t) => {
  const interaction = makeFakeInteraction({
    channelId: 'chan-ping',
    strings: { message: '@everyone @here <@&other-role> mirad esto' },
  });
  await executeCreating(interaction, t);

  const [announcement] = interaction._channelSends;
  assert.equal(announcement.embeds[0].toJSON().fields[0].value, '@everyone @here <@&other-role> mirad esto', 'se ve como texto');
  assert.doesNotMatch(announcement.content, /@everyone|@here|other-role/, 'nada del mensaje en el texto, que es lo único que puede notificar');
  assert.deepEqual(announcement.allowedMentions.parse, []);
  assert.deepEqual(announcement.allowedMentions.roles, []);
});

test('/sorteo: más de 300 caracteres se rechaza diciendo cuántos sobran', async () => {
  const interaction = makeFakeInteraction({ channelId: 'chan-long', strings: { message: 'a'.repeat(305) } });
  await execute(interaction);

  assert.equal(interaction._replies[0].ephemeral, true);
  assert.match(interaction._replies[0].embeds[0].toJSON().description, /como mucho 300 caracteres: sobran 5\./);
  assert.equal(interaction._channelSends.length, 0);
});

test('/sorteo: ganadores fuera de 1-20 se rechaza con el rango', async () => {
  const interaction = makeFakeInteraction({ channelId: 'chan-winners', integers: { winners: 21 } });
  await execute(interaction);

  assert.match(interaction._replies[0].embeds[0].toJSON().description, /entre 1 y 20/);
  assert.equal(interaction._channelSends.length, 0);
});

test('normalizeRaffleMessage(): la secuencia literal "\\n" es un salto real, 3+ saltos se quedan en 2, vacío es null', () => {
  assert.equal(normalizeRaffleMessage('a\\nb'), 'a\nb');
  assert.equal(normalizeRaffleMessage('a' + '\\n'.repeat(20) + 'b'), 'a\n\nb');
  assert.equal(normalizeRaffleMessage('a\\n  \\n \\n\\nb'), 'a\n\nb', 'las líneas con solo espacios cuentan como vacías');
  assert.equal(normalizeRaffleMessage('a\n\n\n\nb'), 'a\n\nb', 'también los saltos reales (pegados)');
  assert.equal(normalizeRaffleMessage('  \\n  '), null);
  assert.equal(normalizeRaffleMessage(null), null);
});

test('/sorteo: el límite de 300 se cuenta sobre el texto normalizado (cada \\n es un carácter)', async (t) => {
  const interaction = makeFakeInteraction({ channelId: 'chan-limit', strings: { message: `${'a'.repeat(149)}\\n${'b'.repeat(150)}` } });
  await executeCreating(interaction, t);
  assert.equal(interaction._channelSends.length, 1, '300 caracteres exactos tras normalizar: se acepta');
});
