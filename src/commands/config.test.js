import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtemp, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// DATA_DIR temporal, fijado ANTES de importar nada que lo lea.
const DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'config-cmd-test-'));
process.env.DATA_DIR = DATA_DIR;
after(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
});

const { PermissionFlagsBits, ChannelType } = await import('discord.js');
const { getConfig, setConfig, rutaDe } = await import('../services/guildStore.js');
const { createSquad } = await import('../services/squadsStore.js');
const { loadConfig } = await import('../services/config.js');
const { MissingConfigError } = await import('../services/configFields.js');
const { AlbionbbApiError } = await import('../services/albionbbApi.js');
const { execute, __setAlbionbbCheckForTests } = await import('./config.js');
const { execute: executeSquads } = await import('./squads.js');
const { execute: executeGetkills } = await import('./getkills.js');
const { handleInteractionError } = await import('../interactionErrorHandler.js');

let nextGuild = 200000000000000000n;
function newGuildId() {
  nextGuild += 1n;
  return String(nextGuild);
}

function makeGuild({ roles = [], channels = new Map(), preferredLocale = 'en-US' } = {}) {
  return {
    preferredLocale,
    roles: { cache: new Map(roles.map((id) => [id, { id }])) },
    channels: {
      cache: channels,
      fetch: async (id) => channels.get(id) ?? null,
    },
    members: { me: { id: 'bot' }, fetchMe: async () => ({ id: 'bot' }) },
  };
}

function makeChannel(id, { type = ChannelType.GuildText, allowed = true } = {}) {
  return { id, type, permissionsFor: () => ({ has: () => allowed }) };
}

// Por defecto, un administrador con el cliente en español: las respuestas de
// /config son efímeras y salen en su idioma.
function makeInteraction({
  guildId,
  subcommand,
  admin = true,
  options = {},
  guild = makeGuild(),
  logSends = [],
  locale = 'es-ES',
}) {
  const replies = [];
  const edits = [];
  return {
    guildId,
    guild,
    locale,
    user: { id: '300000000000000001', tag: 'Admin#0001' },
    memberPermissions: { has: (flag) => admin && flag === PermissionFlagsBits.Administrator },
    member: { roles: { cache: new Map() } },
    client: {
      channels: {
        fetch: async (id) => ({
          id,
          guildId,
          isTextBased: () => true,
          send: async (payload) => logSends.push({ channelId: id, payload }),
        }),
      },
    },
    options: {
      getSubcommand: () => subcommand,
      getString: (name) => options[name] ?? null,
      getRole: (name) => options[name] ?? null,
      getChannel: (name) => options[name] ?? null,
    },
    deferred: false,
    replied: false,
    async reply(payload) {
      this.replied = true;
      replies.push(payload);
    },
    async deferReply() {
      this.deferred = true;
    },
    async editReply(payload) {
      edits.push(payload);
    },
    _replies: replies,
    _edits: edits,
    _logSends: logSends,
  };
}

function embedText(payload) {
  const json = payload.embeds[0].toJSON();
  return [json.title, json.description, ...(json.fields ?? []).flatMap((f) => [f.name, f.value])].join('\n');
}

test('/config: sin permiso de Administrador no hace nada, aunque lo vea en el picker', async () => {
  const guildId = newGuildId();
  const interaction = makeInteraction({ guildId, subcommand: 'guild', admin: false, options: { name: 'FOAB' } });

  await execute(interaction);

  assert.match(embedText(interaction._replies[0]), /Administrador/);
  assert.equal(interaction._replies[0].ephemeral, true);
  assert.equal((await getConfig(guildId)).albionGuild, null);
});

test('/config view: en un servidor nuevo marca lo que falta y qué comandos no funcionan', async () => {
  const guildId = newGuildId();
  const interaction = makeInteraction({ guildId, subcommand: 'view' });

  await execute(interaction);

  const text = embedText(interaction._edits[0]);
  assert.match(text, /Rol de oficiales · \/config officer\n❌/);
  assert.match(text, /Gremio de Albion · \/config guild\n❌/);
  assert.match(text, /Servidor de Albion[^\n]*\n✅ `europe`/);
  assert.match(text, /Rol a avisar en sorteos[^\n]*\n➖/);
  // Los comandos, con el nombre que teclea quien lo lee: /sorteo, no /raffle.
  assert.match(text, /\/getkills no funciona: falta el gremio de Albion → `\/config guild`/);
  assert.match(text, /\/squads, \/sorteo, \/crear-rol, \/estado no funcionan: falta el rol de oficiales/);
  assert.match(text, /\/asistencia no funciona/);
});

test('/config view: con el cliente en inglés, en inglés y con los nombres ingleses de los comandos', async () => {
  const guildId = newGuildId();
  const interaction = makeInteraction({ guildId, subcommand: 'view', locale: 'en-US' });

  await execute(interaction);

  const text = embedText(interaction._edits[0]);
  assert.match(text, /Officer role · \/config officer\n❌ \*\*not configured\*\*/);
  assert.match(text, /\/squads, \/raffle, \/create-role, \/health don't work: the officer role is missing/);
});

test('/config view: un rol configurado que ya no existe se marca como roto', async () => {
  const guildId = newGuildId();
  await setConfig(guildId, { officerRoleId: '400000000000000001' });
  const interaction = makeInteraction({ guildId, subcommand: 'view', guild: makeGuild({ roles: [] }) });

  await execute(interaction);

  assert.match(embedText(interaction._edits[0]), /⚠️ El rol configurado \(`400000000000000001`\) ya no existe/);
});

test('/config guild: guarda, registra en el canal de logs (idioma del servidor) y deja constancia de quién', async () => {
  const guildId = newGuildId();
  await setConfig(guildId, { logChannelId: '500000000000000001', idioma: 'en' });
  // Quien lo cambia tiene el cliente en español; el servidor está en inglés.
  const interaction = makeInteraction({ guildId, subcommand: 'guild', options: { name: '  Los Del Fondo ' } });

  await execute(interaction);

  const config = await getConfig(guildId);
  assert.equal(config.albionGuild, 'Los Del Fondo');
  assert.equal(config.configuradoPor, '300000000000000001');
  assert.ok(config.configuradoEn);
  assert.match(embedText(interaction._edits[0]), /Antes:\*\* sin configurar\n\*\*Ahora:\*\* `Los Del Fondo`/);

  assert.equal(interaction._logSends.length, 1);
  assert.equal(interaction._logSends[0].channelId, '500000000000000001');
  assert.match(embedText(interaction._logSends[0].payload), /Albion guild[\s\S]*not configured[\s\S]*`Los Del Fondo`/);
});

test('/config guild: varios separados por comas se rechazan y apuntan a /squads create', async () => {
  const guildId = newGuildId();
  const interaction = makeInteraction({ guildId, subcommand: 'guild', options: { name: 'FOAB, Otro' } });

  await execute(interaction);

  assert.match(embedText(interaction._edits[0]), /un solo gremio[\s\S]*\/squads create name:<gremio> is-guild:true/);
  assert.equal((await getConfig(guildId)).albionGuild, null);
});

test('/config guild: no puede ser un gremio que ya sigue un squad de gremio', async () => {
  const guildId = newGuildId();
  await createSquad(guildId, 'Dementia', { isGuild: true });
  const interaction = makeInteraction({ guildId, subcommand: 'guild', options: { name: 'dementia' } });

  await execute(interaction);

  assert.match(embedText(interaction._edits[0]), /Ya hay un squad de gremio que sigue a \*\*Dementia\*\*/);
  assert.equal((await getConfig(guildId)).albionGuild, null);
});

test('/config logs: un canal donde el bot no puede escribir se rechaza diciendo qué permiso falta', async () => {
  const guildId = newGuildId();
  const channel = makeChannel('500000000000000002', { allowed: false });
  const interaction = makeInteraction({
    guildId,
    subcommand: 'logs',
    options: { channel: { id: channel.id } },
    guild: makeGuild({ channels: new Map([[channel.id, channel]]) }),
  });

  await execute(interaction);

  assert.match(embedText(interaction._edits[0]), /No puedo escribir en <#500000000000000002>[\s\S]*Enviar mensajes/);
  assert.equal((await getConfig(guildId)).logChannelId, null);
});

test('/config logs: un canal de voz se rechaza', async () => {
  const guildId = newGuildId();
  const channel = makeChannel('500000000000000003', { type: ChannelType.GuildVoice });
  const interaction = makeInteraction({
    guildId,
    subcommand: 'logs',
    options: { channel: { id: channel.id } },
    guild: makeGuild({ channels: new Map([[channel.id, channel]]) }),
  });

  await execute(interaction);

  assert.match(embedText(interaction._edits[0]), /canal de texto/);
  assert.equal((await getConfig(guildId)).logChannelId, null);
});

test('/config reset logs: el aviso va al canal que deja de serlo', async () => {
  const guildId = newGuildId();
  await setConfig(guildId, { logChannelId: '500000000000000004' });
  const interaction = makeInteraction({ guildId, subcommand: 'reset', options: { field: 'logs' } });

  await execute(interaction);

  assert.equal((await getConfig(guildId)).logChannelId, null);
  assert.equal(interaction._logSends.length, 1);
  assert.equal(interaction._logSends[0].channelId, '500000000000000004');
});

test('/config reset server: vuelve al valor por defecto (europe), no a null', async () => {
  const guildId = newGuildId();
  await setConfig(guildId, { albionServer: 'asia' });
  await execute(makeInteraction({ guildId, subcommand: 'reset', options: { field: 'server' } }));
  assert.equal((await getConfig(guildId)).albionServer, 'europe');
});

test('/config officer: @everyone se rechaza', async () => {
  const guildId = newGuildId();
  const interaction = makeInteraction({ guildId, subcommand: 'officer', options: { role: { id: guildId, name: '@everyone' } } });

  await execute(interaction);

  assert.match(embedText(interaction._edits[0]), /@everyone no puede ser el rol de oficiales/);
  assert.equal((await getConfig(guildId)).officerRoleId, null);
});

test('/config albionbb: acepta la URL de la página del gremio y comprueba el id en el servidor configurado', async () => {
  const guildId = newGuildId();
  await setConfig(guildId, { albionServer: 'americas' });
  const checks = [];
  __setAlbionbbCheckForTests(async (server, id) => checks.push({ server, id }));

  await execute(
    makeInteraction({
      guildId,
      subcommand: 'albionbb',
      options: { value: 'https://americas.albionbb.com/guilds/95VpWaVRTBuiBAw4XVvpZw/attendance' },
    }),
  );

  assert.deepEqual(checks, [{ server: 'americas', id: '95VpWaVRTBuiBAw4XVvpZw' }]);
  assert.equal((await getConfig(guildId)).albionbbGuildId, '95VpWaVRTBuiBAw4XVvpZw');
});

test('/config albionbb: un id que albionbb no conoce no se guarda', async () => {
  const guildId = newGuildId();
  __setAlbionbbCheckForTests(async () => {
    throw new AlbionbbApiError('Guild not found', { status: 404, guildId: 'x' });
  });
  const interaction = makeInteraction({ guildId, subcommand: 'albionbb', options: { value: 'noExiste123' } });

  await execute(interaction);

  assert.match(embedText(interaction._edits[0]), /albionbb no tiene ningún gremio con id `noExiste123`[\s\S]*\/config server/);
  assert.equal((await getConfig(guildId)).albionbbGuildId, null);
});

// --- /config language ---

test('/config language: cambia el idioma de los mensajes públicos del servidor', async () => {
  const guildId = newGuildId();
  await setConfig(guildId, { idioma: 'en', logChannelId: '500000000000000005' });
  const interaction = makeInteraction({ guildId, subcommand: 'language', options: { value: 'es' } });

  await execute(interaction);

  assert.equal((await getConfig(guildId)).idioma, 'es');
  assert.match(embedText(interaction._edits[0]), /Antes:\*\* Inglés\n\*\*Ahora:\*\* Español/);
  // El propio aviso del cambio ya sale en el idioma nuevo.
  assert.match(embedText(interaction._logSends[0].payload), /cambió la configuración/);
});

test('/config language: un idioma que no existe se rechaza', async () => {
  const guildId = newGuildId();
  const interaction = makeInteraction({ guildId, subcommand: 'language', options: { value: 'fr' } });

  await execute(interaction);

  assert.match(embedText(interaction._edits[0]), /El idioma tiene que ser uno de: en, es/);
  assert.equal((await getConfig(guildId)).idioma, null);
});

test('/config reset language: vuelve al idioma del servidor de Discord, no a null', async () => {
  const guildId = newGuildId();
  await setConfig(guildId, { idioma: 'en' });
  await execute(
    makeInteraction({ guildId, subcommand: 'reset', options: { field: 'language' }, guild: makeGuild({ preferredLocale: 'es-419' }) }),
  );
  assert.equal((await getConfig(guildId)).idioma, 'es');
});

// --- gating: los demás comandos dicen qué falta y con qué se arregla ---

test('/squads sin rol de oficiales: dice que falta y apunta a /config officer', async () => {
  const guildId = newGuildId();
  const interaction = makeInteraction({ guildId, subcommand: 'list' });

  await executeSquads(interaction);

  const text = embedText(interaction._replies[0]);
  assert.match(text, /Falta configuración/);
  assert.match(text, /no tiene rol de oficiales configurado[\s\S]*`\/config officer`/);
});

test('/squads con un rol de oficiales borrado: lo dice en vez de "Sin permiso"', async () => {
  const guildId = newGuildId();
  await setConfig(guildId, { officerRoleId: '400000000000000002' });
  const interaction = makeInteraction({ guildId, subcommand: 'list', guild: makeGuild({ roles: [] }) });

  await executeSquads(interaction);

  assert.match(embedText(interaction._replies[0]), /ya no existe[\s\S]*`\/config officer`/);
});

test('/getkills sin gremio: el error dice qué falta y con qué comando, a cualquiera que lo ejecute', async () => {
  const guildId = newGuildId();
  const interaction = makeInteraction({ guildId, subcommand: null, options: { url: 'https://europe.albionbb.com/battles/418186013' } });

  const error = await executeGetkills(interaction).then(
    () => null,
    (err) => err,
  );
  assert.ok(error instanceof MissingConfigError);

  const { known } = await handleInteractionError(interaction, error);
  assert.equal(known, true);
  assert.equal(
    interaction._edits.at(-1).embeds[0].toJSON().description,
    'Este servidor no tiene gremio de Albion configurado. Un administrador puede ponerlo con `/config guild`.',
  );
});

test('un servidor sin squads.json es un servidor sin squads, no un error', async () => {
  const guildId = newGuildId();
  await assert.rejects(access(rutaDe(guildId, 'squads.json')));

  const config = await loadConfig(guildId);
  assert.equal(config.squadOrder.length, 0);

  await createSquad(guildId, 'foab');
  assert.deepEqual((await loadConfig(guildId)).squadOrder, ['foab']);
});

// --- quién puede usar /config: Administrador, no el rol de oficiales ---

test('/config: un oficial SIN permiso de Administrador no puede, ni teniendo el rol', async () => {
  const guildId = newGuildId();
  await setConfig(guildId, { officerRoleId: '400000000000000009' });
  const interaction = makeInteraction({ guildId, subcommand: 'guild', admin: false, options: { name: 'FOAB' } });
  interaction.member = { roles: { cache: new Map([['400000000000000009', true]]) } };

  await execute(interaction);

  assert.match(embedText(interaction._replies[0]), /Administrador/);
  assert.equal((await getConfig(guildId)).albionGuild, null);
});

test('/config: un Administrador SIN el rol de oficiales sí puede (servidor recién añadido)', async () => {
  const guildId = newGuildId();
  await setConfig(guildId, { officerRoleId: '400000000000000010' });
  const interaction = makeInteraction({ guildId, subcommand: 'guild', options: { name: 'FOAB' } });

  await execute(interaction);

  assert.equal((await getConfig(guildId)).albionGuild, 'FOAB');
});
