import { test, after, before, mock } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Aislamiento entre servidores de punta a punta: cada caso pasa por el
// execute() del comando, no por el servicio, que es donde una variable o una
// caché sin indexar se colaría. DATA_DIR temporal fijado ANTES de importar.
const DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'multiguild-isolation-test-'));
process.env.DATA_DIR = DATA_DIR;

const { setConfig, rutaDe } = await import('./services/guildStore.js');
const { createSquad, addPlayers } = await import('./services/squadsStore.js');
const { loadConfig } = await import('./services/config.js');
const { loadRaffles } = await import('./services/rafflesStore.js');
const { resolveRaffle, scheduleRaffleResolution } = await import('./raffleScheduler.js');
const { execute: squads } = await import('./commands/squads.js');
const { execute: getkills } = await import('./commands/getkills.js');
const { execute: sorteo } = await import('./commands/sorteo.js');

const A = '800000000000000001';
const B = '800000000000000002';
const OFFICER_A = '810000000000000001';
const OFFICER_B = '810000000000000002';

// --- una batalla con jugadores de los dos gremios (API de Albion simulada) ---

const BATTLE_ID = 990001;
const BATTLE_URL = `https://europe.albionbb.com/battles/${BATTLE_ID}`;
const p = (name, guild, alliance = 'SHARED') => ({ Name: name, GuildName: guild, AllianceName: alliance });
const players = {
  a1: p('PlayerA1', 'GuildA'),
  a2: p('PlayerA2', 'GuildA'),
  b1: p('PlayerB1', 'GuildB'),
  b2: p('PlayerB2', 'GuildB'),
  e1: p('Enemy1', 'Rival', 'FOE'),
  e2: p('Enemy2', 'Rival', 'FOE'),
};
const kill = (id, killer, victim) => ({
  EventId: id,
  TimeStamp: '2026-10-20T20:00:00Z',
  Killer: killer,
  Victim: victim,
  Participants: [killer],
});
// GuildA: 2 kills, 0 muertes. GuildB: 1 kill, 1 muerte.
const EVENTS = [
  kill(1, players.a1, players.e1),
  kill(2, players.a2, players.e2),
  kill(3, players.b1, players.e1),
  kill(4, players.e2, players.b2),
];
const BATTLE = {
  players: Object.fromEntries(
    Object.entries(players).map(([id, pl]) => [
      id,
      { name: pl.Name, guildName: pl.GuildName, allianceName: pl.AllianceName, kills: 0, deaths: 0 },
    ]),
  ),
};

const realFetch = globalThis.fetch;
before(async () => {
  globalThis.fetch = async (url) => {
    const body = String(url).includes('/events/battle/') ? EVENTS : BATTLE;
    return { ok: true, status: 200, json: async () => structuredClone(body) };
  };

  // Los dos servidores en español: lo público sale en español.
  await setConfig(A, { officerRoleId: OFFICER_A, albionGuild: 'GuildA', idioma: 'es' });
  await setConfig(B, { officerRoleId: OFFICER_B, albionGuild: 'GuildB', idioma: 'es' });
  await createSquad(A, 'alpha');
  await addPlayers(A, 'alpha', 'PlayerA1');
  await createSquad(B, 'bravo');
  await addPlayers(B, 'bravo', 'PlayerB1');
});
after(async () => {
  globalThis.fetch = realFetch;
  await rm(DATA_DIR, { recursive: true, force: true });
});

// --- interacción falsa ---

function makeInteraction({ guildId, roles = [], subcommand = null, options = {}, locale = 'es-ES' }) {
  const replies = [];
  const edits = [];
  const channelSends = [];
  return {
    guildId,
    locale,
    channelId: `canal-${guildId}`,
    guild: { id: guildId, roles: { cache: new Map([[OFFICER_A, {}], [OFFICER_B, {}]]) } },
    member: { roles: { cache: new Map(roles.map((role) => [role, true])) } },
    user: { id: `user-${guildId}`, tag: 'Oficial#0001' },
    client: { channels: { fetch: async () => null } },
    channel: {
      send: async (payload) => {
        channelSends.push(payload);
        return { id: `msg-${guildId}`, react: async () => {} };
      },
    },
    options: {
      getSubcommand: () => subcommand,
      getString: (name) => options[name] ?? null,
      getBoolean: (name) => options[name] ?? null,
      getInteger: (name) => options[name] ?? null,
      getRole: (name) => options[name] ?? null,
    },
    deferred: false,
    replied: false,
    async deferReply() {
      this.deferred = true;
    },
    async reply(payload) {
      this.replied = true;
      replies.push(payload);
    },
    async editReply(payload) {
      edits.push(payload);
    },
    _replies: replies,
    _edits: edits,
    _channelSends: channelSends,
  };
}

const text = (payload) => payload.embeds.map((embed) => JSON.stringify(embed.toJSON())).join('\n');

// --- /squads ---

test('/squads list en A muestra solo los squads de A, y en B solo los de B', async () => {
  const inA = makeInteraction({ guildId: A, roles: [OFFICER_A], subcommand: 'list' });
  await squads(inA);
  assert.match(text(inA._edits[0]), /ALPHA/);
  assert.doesNotMatch(text(inA._edits[0]), /BRAVO/);

  const inB = makeInteraction({ guildId: B, roles: [OFFICER_B], subcommand: 'list' });
  await squads(inB);
  assert.match(text(inB._edits[0]), /BRAVO/);
  assert.doesNotMatch(text(inB._edits[0]), /ALPHA/);
});

test('añadir un jugador en A no aparece en B', async () => {
  const before = await readFile(rutaDe(B, 'squads.json'), 'utf8');

  await squads(
    makeInteraction({ guildId: A, roles: [OFFICER_A], subcommand: 'add', options: { squad: 'alpha', players: 'SoloEnA' } }),
  );

  assert.ok((await loadConfig(A)).playerToSquad.has('soloena'));
  assert.equal((await loadConfig(B)).playerToSquad.has('soloena'), false);
  assert.equal(await readFile(rutaDe(B, 'squads.json'), 'utf8'), before);
});

test('un oficial de A sin el rol de B no puede mutar nada en B', async () => {
  const before = await readFile(rutaDe(B, 'squads.json'), 'utf8');

  for (const [subcommand, options] of [
    ['create', { name: 'intruso' }],
    ['add', { squad: 'bravo', players: 'Intruso' }],
    ['delete', { squad: 'bravo' }],
  ]) {
    const interaction = makeInteraction({ guildId: B, roles: [OFFICER_A], subcommand, options });
    await squads(interaction);
    assert.match(text(interaction._replies[0]), /Sin permiso/);
  }
  assert.equal(await readFile(rutaDe(B, 'squads.json'), 'utf8'), before);
});

test('A y JUSTO DESPUÉS B: el segundo no devuelve datos del primero (cachés indexadas)', async () => {
  const showA = makeInteraction({ guildId: A, roles: [OFFICER_A], subcommand: 'show', options: { squad: 'alpha' } });
  await squads(showA);
  assert.match(text(showA._edits[0]), /PlayerA1/);

  const showB = makeInteraction({ guildId: B, roles: [OFFICER_B], subcommand: 'show', options: { squad: 'alpha' } });
  await squads(showB);
  assert.match(text(showB._edits[0]), /no existe/);

  // Y en paralelo, que es donde una caché compartida se pisaría.
  const [listA, listB] = [
    makeInteraction({ guildId: A, roles: [OFFICER_A], subcommand: 'list' }),
    makeInteraction({ guildId: B, roles: [OFFICER_B], subcommand: 'list' }),
  ];
  await Promise.all([squads(listA), squads(listB)]);
  assert.doesNotMatch(text(listA._edits[0]), /BRAVO/);
  assert.doesNotMatch(text(listB._edits[0]), /ALPHA/);
});

// --- /getkills ---

test('/getkills en A usa el gremio y los squads de A; justo después en B, los de B', async () => {
  const inA = makeInteraction({ guildId: A, options: { url: BATTLE_URL } });
  await getkills(inA);
  const resultA = text(inA._edits[0]);
  assert.match(resultA, /TOTAL GuildA/);
  assert.match(resultA, /K-D: 2 - 0/);
  assert.match(resultA, /ALPHA[\s\S]*PlayerA1/);
  assert.doesNotMatch(resultA, /GuildB|BRAVO/);

  const inB = makeInteraction({ guildId: B, options: { url: BATTLE_URL } });
  await getkills(inB);
  const resultB = text(inB._edits[0]);
  assert.match(resultB, /TOTAL GuildB/);
  assert.match(resultB, /K-D: 1 - 1/);
  assert.match(resultB, /BRAVO/);
  assert.doesNotMatch(resultB, /GuildA|ALPHA/);
});

// --- /sorteo ---

test('dos sorteos simultáneos, uno en cada servidor: cada uno en su fichero y se resuelven por separado', async (t) => {
  // Sin esto los dos temporizadores reales de 30 minutos mantendrían vivo el proceso.
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const inA = makeInteraction({ guildId: A, roles: [OFFICER_A], options: { minutes: 30 } });
  const inB = makeInteraction({ guildId: B, roles: [OFFICER_B], options: { minutes: 30 } });
  await Promise.all([sorteo(inA), sorteo(inB)]);

  const [rafflesA, rafflesB] = [await loadRaffles(A), await loadRaffles(B)];
  assert.deepEqual(rafflesA.map((r) => [r.guildId, r.channelId]), [[A, `canal-${A}`]]);
  assert.deepEqual(rafflesB.map((r) => [r.guildId, r.channelId]), [[B, `canal-${B}`]]);

  // Resolver el de A (canal ya inaccesible) no toca el de B.
  await resolveRaffle({ channels: { fetch: async () => Promise.reject(new Error('sin acceso')) } }, rafflesA[0]);
  assert.deepEqual(await loadRaffles(A), []);
  assert.equal((await loadRaffles(B)).length, 1);
});

// --- bordes ---

test('/getkills en un servidor sin squads.json no falla: todo cuenta como MAIN ZERG', async () => {
  const guildId = '800000000000000003';
  await setConfig(guildId, { albionGuild: 'GuildA' });
  const interaction = makeInteraction({ guildId, options: { url: BATTLE_URL } });
  await getkills(interaction);
  assert.match(text(interaction._edits[0]), /TOTAL GuildA[\s\S]*K-D: 2 - 0/);
});

// --- hallazgos de la verificación multiservidor (#4 a #7) ---

test('/getkills en un servidor sin squads dice que no los tiene y cómo crearlos', async () => {
  const guildId = '800000000000000004';
  await setConfig(guildId, { albionGuild: 'GuildA' });
  const interaction = makeInteraction({ guildId, options: { url: BATTLE_URL } });
  await getkills(interaction);
  assert.match(text(interaction._edits[0]), /\/squads create/);
});

test('/squads show conserva las mayúsculas de squads.json', async () => {
  const show = makeInteraction({ guildId: A, roles: [OFFICER_A], subcommand: 'show', options: { squad: 'alpha' } });
  await squads(show);
  assert.match(text(show._edits[0]), /PlayerA1/);
});

test('el autocompletado de /squads no enseña squads ni jugadores a quien no es oficial', async () => {
  let choices = null;
  const { autocomplete } = await import('./commands/squads.js');
  await autocomplete({
    guildId: A,
    guild: { roles: { cache: new Map([[OFFICER_A, {}]]) } },
    member: { roles: { cache: new Map() } },
    options: { getFocused: () => ({ name: 'squad', value: '' }), getSubcommand: () => 'show', getString: () => null },
    respond: async (list) => {
      choices = list;
    },
  });
  assert.deepEqual(choices, []);
});

test('un sorteo resuelto fuera de su temporizador no se vuelve a resolver cuando este vence', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  let fetches = 0;
  const client = { channels: { fetch: async () => { fetches += 1; throw new Error('sin acceso'); } } };
  const raffle = { id: 'r-doble', guildId: '800000000000000005', channelId: 'c', messageId: 'm', endsAt: Date.now() + 60_000, creatorId: 'u' };

  scheduleRaffleResolution(client, raffle);
  await resolveRaffle(client, raffle);
  mock.timers.tick(120_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches, 1);
});

test('el autocompletado de /squads (remove, find) ofrece los nombres con su casing original', async () => {
  const { autocomplete } = await import('./commands/squads.js');
  const ask = async (subcommand) => {
    let choices = null;
    await autocomplete({
      guildId: A,
      guild: { roles: { cache: new Map([[OFFICER_A, {}]]) } },
      member: { roles: { cache: new Map([[OFFICER_A, true]]) } },
      options: {
        getFocused: () => ({ name: 'player', value: 'playera' }),
        getSubcommand: () => subcommand,
        getString: () => 'alpha',
      },
      respond: async (list) => {
        choices = list;
      },
    });
    return choices.map((choice) => choice.name);
  };
  assert.deepEqual(await ask('remove'), ['PlayerA1']);
  assert.deepEqual(await ask('find'), ['PlayerA1']);
});

test('/squads find responde con el nombre tal cual está en squads.json', async () => {
  const find = makeInteraction({ guildId: A, roles: [OFFICER_A], subcommand: 'find', options: { player: 'PLAYERA1' } });
  await squads(find);
  assert.match(find._edits[0].content, /\*\*PlayerA1\*\* está en el squad \*\*ALPHA\*\*/);
});

// --- idioma: público en el del servidor, efímero en el de quien lo provoca ---

test('un embed público sale en el idioma del servidor, no en el de quien lo ejecutó', async () => {
  // Usuario con el cliente en inglés en un servidor configurado en español.
  const inA = makeInteraction({ guildId: A, options: { url: BATTLE_URL }, locale: 'en-US' });
  await getkills(inA);
  const result = text(inA._edits[0]);
  assert.match(result, /Batallas procesadas: 1\/1/);
  assert.doesNotMatch(result, /Battles processed/);
});

test('una respuesta efímera sale en el idioma de quien la provocó, y el público del mismo comando en el del servidor', async () => {
  // /squads add es efímero: inglés para quien lo pide aunque el servidor esté en español.
  const add = makeInteraction({
    guildId: A,
    roles: [OFFICER_A],
    subcommand: 'add',
    options: { squad: 'alpha', players: 'IdiomaTest' },
    locale: 'en-US',
  });
  await squads(add);
  const reply = add._edits[0].embeds[0].toJSON();
  assert.equal(reply.title, 'Squad "ALPHA" updated');
  assert.equal(reply.description, 'Added: IdiomaTest');
  assert.equal(reply.footer.text, 'Edited by Oficial#0001');

  // /squads list es público: español, aunque lo pida la misma persona.
  const list = makeInteraction({ guildId: A, roles: [OFFICER_A], subcommand: 'list', locale: 'en-US' });
  await squads(list);
  assert.match(text(list._edits[0]), /Squads de jugadores/);
});

test('/config language cambia el idioma de los mensajes públicos', async () => {
  const guildId = '800000000000000009';
  await setConfig(guildId, { albionGuild: 'GuildA', idioma: 'es' });
  const before = makeInteraction({ guildId, options: { url: BATTLE_URL } });
  await getkills(before);
  assert.match(text(before._edits[0]), /Batallas procesadas/);

  await setConfig(guildId, { idioma: 'en' }); // lo mismo que guarda /config language en
  const after = makeInteraction({ guildId, options: { url: BATTLE_URL } });
  await getkills(after);
  assert.match(text(after._edits[0]), /Battles processed/);
});
