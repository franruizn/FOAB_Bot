import { test, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

// Verificación de punta a punta de /strike y del informe semanal, sin red:
// guild y member son dobles en memoria y el reloj del informe está simulado.
//
// Un test con { todo: 'S-n ...' } documenta un defecto conocido y todavía
// abierto: comprueba el comportamiento CORRECTO, así que falla hasta que se
// arregle. Al arreglarlo, se le quita el todo.

process.env.TZ = 'Europe/Madrid';
const DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'strikes-verify-'));
process.env.DATA_DIR = DATA_DIR;

const { setConfig, rutaDe } = await import('./services/guildStore.js');
const { addStrike, removeLatestStrike, loadStrikes, loadStrikesFile, markReportSent, activeStrikes } = await import('./services/strikesStore.js');
const { resolvePresent } = await import('./services/memberPresence.js');
const { execute } = await import('./commands/strike.js');
const { onGuildRemoved } = await import('./guildLifecycle.js');
const { initializeStrikeReports, syncStrikeReport, cancelStrikeReport, __scheduledGuildsForTests } = await import('./strikeReportScheduler.js');

after(() => rm(DATA_DIR, { recursive: true, force: true, maxRetries: 5 }));

const OFFICER = '100000000000000001';
const TARGET = '100000000000000002';
const NO_PINGS = { parse: [] };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Lunes 23/11/2026 a las 12:00 en Madrid.
const SLOT = new Date(2026, 10, 23, 12).getTime();

let nextGuild = 910000000000000000n;
const newGuildId = () => String(++nextGuild);
const roleOf = (guildId) => `role-${guildId}`;
const logOf = (guildId) => `log-${guildId}`;

const user = (id, extra = {}) => ({ id, username: `user${id.slice(-3)}`, tag: `user${id.slice(-3)}`, bot: false, ...extra });

async function newGuild(extra = {}) {
  const guildId = newGuildId();
  await setConfig(guildId, { officerRoleId: roleOf(guildId), logChannelId: logOf(guildId), idioma: 'es', ...extra });
  return guildId;
}

function guildDouble(guildId, memberIds = null) {
  const cache = new Map((memberIds ?? []).map((id) => [id, {}]));
  return {
    id: guildId,
    available: true,
    roles: { cache: new Map([[roleOf(guildId), {}]]) },
    members: {
      cache,
      // Sin lista explícita, todos los pedidos están en el servidor.
      fetch: async ({ user: ids }) => new Map(ids.filter((id) => memberIds === null || cache.has(id)).map((id) => [id, {}])),
    },
  };
}

function clientDouble(guildIds = [], { failSend = false } = {}) {
  const sent = [];
  return {
    sent,
    guilds: { cache: new Map(guildIds.map((id) => [id, guildDouble(id)])) },
    channels: {
      fetch: async (channelId) => ({
        guildId: channelId.replace('log-', ''),
        isTextBased: () => true,
        send: async (payload) => {
          if (failSend) throw new Error('Missing Access');
          sent.push({ channelId, payload });
        },
      }),
    },
  };
}

let nextInteraction = 1;

/** Interacción de /strike. `roles` por defecto: oficial de ESE servidor. */
function strike(guildId, sub, { target = user(TARGET), reason = null, actor = user(OFFICER), roles, click = null, member = {}, guild, client, failEdit = false } = {}) {
  const id = String(nextInteraction++);
  const replies = [];
  const collector = new EventEmitter();
  let prompted = 0;
  const message = {
    createMessageComponentCollector: () => collector,
    awaitMessageComponent: async () => {
      prompted++;
      if (!click) throw new Error('timeout');
      return {
        customId: `strike-clear-${click}-${id}`,
        user: actor,
        deferUpdate: async () => {},
        update: async (payload) => replies.push(payload),
        editReply: async (payload) => replies.push(payload),
      };
    },
  };
  return {
    id,
    guildId,
    guild: guild ?? guildDouble(guildId),
    locale: 'es-ES',
    client: client ?? clientDouble([guildId]),
    user: actor,
    member: { roles: { cache: new Map((roles ?? [roleOf(guildId)]).map((role) => [role, {}])) } },
    options: {
      getSubcommand: () => sub,
      getUser: () => target,
      getString: () => reason,
      getMember: () => (member === null ? null : { id: target.id, ...member }),
    },
    replies,
    collector,
    get prompted() {
      return prompted;
    },
    reply: async (payload) => replies.push(payload),
    deferReply: async () => {},
    editReply: async (payload) => {
      if (failEdit) throw new Error('Unknown Webhook');
      replies.push(payload);
      return message;
    },
  };
}

const lastEmbed = (i) => i.replies.at(-1).embeds[0].toJSON();
const seed = (guildId, reason = 'motivo', userId = TARGET, userName = 'nombre') =>
  addStrike(guildId, { userId, userName, reason, addedBy: OFFICER });
const active = async (guildId, userId = TARGET) => activeStrikes(await loadStrikes(guildId), userId);

function embedLength(embed) {
  return (embed.title?.length ?? 0) + (embed.description?.length ?? 0) + (embed.footer?.text.length ?? 0) +
    (embed.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0);
}

function assertWithinEmbedLimits(embed) {
  assert.ok((embed.description?.length ?? 0) <= 4096, `descripción de ${embed.description?.length}`);
  assert.ok(embedLength(embed) <= 6000, `embed de ${embedLength(embed)}`);
  for (const field of embed.fields ?? []) assert.ok(field.value.length <= 1024, `field de ${field.value.length}`);
}

// --- modelo ---

test('modelo: add + remove deja el strike en el fichero con removedAt relleno', async () => {
  const g = await newGuild();
  await execute(strike(g, 'add', { reason: 'faltó' }));
  await execute(strike(g, 'remove', { reason: 'apelado' }));
  const raw = JSON.parse(await readFile(rutaDe(g, 'strikes.json'), 'utf8'));
  assert.equal(raw.strikes.length, 1);
  assert.ok(raw.strikes[0].removedAt);
  assert.equal(raw.strikes[0].removedBy, OFFICER);
  assert.equal(raw.strikes[0].removedReason, 'apelado');
});

test('modelo: el recuento de activos ignora los retirados', async () => {
  const g = await newGuild();
  await seed(g);
  await seed(g);
  await removeLatestStrike(g, { userId: TARGET, removedBy: OFFICER });
  assert.equal((await active(g)).length, 1);
  const i = strike(g, 'check');
  await execute(i);
  assert.equal(lastEmbed(i).title, '1 strike activo');
});

test('modelo: con tres strikes, remove quita el más reciente', async (t) => {
  const g = await newGuild();
  mock.timers.enable({ apis: ['Date'], now: SLOT });
  t.after(() => mock.timers.reset());
  for (const reason of ['primero', 'segundo', 'tercero']) {
    await seed(g, reason);
    mock.timers.tick(1000);
  }
  await execute(strike(g, 'remove'));
  assert.deepEqual((await active(g)).map((s) => s.reason), ['primero', 'segundo']);
});

test('modelo: remove sin strikes activos da un mensaje claro y no escribe', async () => {
  const g = await newGuild();
  const i = strike(g, 'remove');
  await execute(i);
  assert.match(lastEmbed(i).description, /no tiene strikes activos/);
  assert.deepEqual(await loadStrikes(g), []);
  assert.equal(i.client.sent.length, 0);
});

test('modelo: clear pide confirmación y quita todos', async () => {
  const g = await newGuild();
  await seed(g);
  await seed(g);
  await seed(g);
  const i = strike(g, 'clear', { click: 'confirm' });
  await execute(i);
  assert.equal(i.prompted, 1);
  assert.equal((await active(g)).length, 0);
  assert.equal((await loadStrikes(g)).length, 3);
});

test('modelo: clear sin strikes no pide confirmación', async () => {
  const g = await newGuild();
  const i = strike(g, 'clear', { click: 'confirm' });
  await execute(i);
  assert.equal(i.prompted, 0);
  assert.equal(i.replies.at(-1).components, undefined);
  assert.match(lastEmbed(i).description, /no tiene strikes activos/);
});

test('modelo: cambiar de nombre de usuario entre dos strikes sigue contando como el mismo', async () => {
  const g = await newGuild();
  await execute(strike(g, 'add', { reason: 'a', target: user(TARGET, { username: 'viejo' }) }));
  await execute(strike(g, 'add', { reason: 'b', target: user(TARGET, { username: 'nuevo' }) }));
  const strikes = await active(g);
  assert.equal(strikes.length, 2);
  assert.equal(strikes[1].userName, 'nuevo');
});

test('modelo: cambiar el APODO del servidor entre dos strikes se refleja en userName', { todo: 'S-1: se guarda username, no el apodo' }, async () => {
  const g = await newGuild();
  await execute(strike(g, 'add', { reason: 'a', member: { displayName: 'ApodoViejo' } }));
  await execute(strike(g, 'add', { reason: 'b', member: { displayName: 'ApodoNuevo' } }));
  const strikes = await active(g);
  assert.equal(strikes.length, 2);
  assert.equal(strikes[1].userName, 'ApodoNuevo');
});

// --- parámetro user ---

test('user: un bot se rechaza en todos los subcomandos con usuario', async () => {
  const g = await newGuild();
  for (const sub of ['add', 'remove', 'clear', 'check']) {
    const i = strike(g, sub, { reason: 'x', target: user(TARGET, { bot: true }) });
    await execute(i);
    assert.equal(lastEmbed(i).title, 'No se puede hacer', sub);
  }
  assert.deepEqual(await loadStrikes(g), []);
});

test('user: uno mismo se rechaza en add, remove y clear', async () => {
  const g = await newGuild();
  await seed(g, 'propio', OFFICER);
  for (const sub of ['add', 'remove', 'clear']) {
    const i = strike(g, sub, { reason: 'x', target: user(OFFICER), click: 'confirm' });
    await execute(i);
    assert.equal(lastEmbed(i).title, 'No se puede hacer', sub);
  }
  assert.equal((await active(g, OFFICER)).length, 1);
});

test('user: quien se fue sale en check con el nombre guardado y la marca', async () => {
  const g = await newGuild();
  await seed(g, 'x', TARGET, 'se_fue');
  const i = strike(g, 'check', { member: null });
  await execute(i);
  assert.match(lastEmbed(i).description, /se\\_fue \*\(se fue del servidor\)\*/);
  assert.doesNotMatch(lastEmbed(i).description, new RegExp(`Usuario: <@${TARGET}>`));
});

test('user: quien se fue sale en list con el nombre guardado y la marca', async () => {
  const g = await newGuild();
  const stays = '100000000000000003';
  await seed(g, 'x', TARGET, 'se_fue');
  await seed(g, 'y', stays, 'sigue');
  const i = strike(g, 'list', { guild: guildDouble(g, [OFFICER, stays]) });
  await execute(i);
  const text = lastEmbed(i).description;
  assert.match(text, /se\\_fue \*\(se fue del servidor\)\*/);
  assert.ok(text.includes(`<@${stays}>`));
  assert.ok(!text.includes(`<@${TARGET}>`));
});

test('user: si falla la comprobación de miembros nadie se marca como ido', async () => {
  const guild = { members: { cache: new Map(), fetch: async () => { throw new Error('timeout'); } } };
  assert.ok((await resolvePresent(guild, [TARGET])).has(TARGET));
});

test('user: un fallo en un lote no borra a quien otro lote ya confirmó como ido', { todo: 'S-2: el catch da a todos por presentes' }, async () => {
  const ids = Array.from({ length: 150 }, (_, n) => `4000000000000${String(n).padStart(5, '0')}`);
  let calls = 0;
  const guild = {
    members: {
      cache: new Map(),
      fetch: async () => {
        if (++calls === 2) throw new Error('rate limited');
        return new Map(); // el primer lote responde: ninguno de esos 100 está
      },
    },
  };
  const present = await resolvePresent(guild, ids);
  assert.ok(!present.has(ids[0]), 'el primer lote ya confirmó que se fue');
  assert.ok(present.has(ids[149]), 'el del lote fallido no se puede afirmar');
});

// --- permisos y aislamiento ---

test('permisos: sin rol, ningún subcomando actúa sobre otra persona', async () => {
  const g = await newGuild();
  await seed(g, 'secreto');
  for (const sub of ['add', 'remove', 'clear', 'check', 'list']) {
    const i = strike(g, sub, { reason: 'x', roles: [], click: 'confirm' });
    await execute(i);
    assert.equal(lastEmbed(i).title, 'Sin permiso', sub);
    assert.doesNotMatch(JSON.stringify(lastEmbed(i)), /secreto/);
    assert.equal(i.replies.at(-1).ephemeral, true, sub);
  }
  const strikes = await loadStrikes(g);
  assert.equal(strikes.length, 1);
  assert.equal(strikes[0].removedAt, null);
});

test('permisos: sin rol solo se puede hacer check de uno mismo (decisión del dueño)', async () => {
  const g = await newGuild();
  await seed(g, 'mío', OFFICER);
  const i = strike(g, 'check', { target: user(OFFICER), roles: [] });
  await execute(i);
  assert.match(lastEmbed(i).description, /mío/);
});

test('aislamiento: un strike de A no aparece en B', async () => {
  const [a, b] = [await newGuild(), await newGuild()];
  await seed(a, 'solo en A');
  const check = strike(b, 'check');
  await execute(check);
  assert.doesNotMatch(lastEmbed(check).description, /solo en A/);
  const list = strike(b, 'list');
  await execute(list);
  assert.match(lastEmbed(list).description, /Nadie/);
});

test('aislamiento: el mismo usuario en A y B tiene recuentos independientes', async () => {
  const [a, b] = [await newGuild(), await newGuild()];
  await seed(a);
  await seed(a);
  await seed(a);
  await seed(b);
  await removeLatestStrike(b, { userId: TARGET, removedBy: OFFICER });
  assert.equal((await active(a)).length, 3);
  assert.equal((await active(b)).length, 0);
});

test('aislamiento: un oficial de A sin el rol en B no puede poner strikes en B', async () => {
  const [a, b] = [await newGuild(), await newGuild()];
  const i = strike(b, 'add', { reason: 'x', roles: [roleOf(a)] });
  await execute(i);
  assert.equal(lastEmbed(i).title, 'Sin permiso');
  assert.deepEqual(await loadStrikes(b), []);
});

// --- embeds ---

test('embeds: list con 40 usuarios pagina dentro de los límites y sin pingar', async () => {
  const g = await newGuild();
  // El peor caso: todos se fueron y tienen un nombre largo que hay que escapar.
  for (let n = 0; n < 40; n++) await seed(g, 'x', `5000000000000${String(n).padStart(5, '0')}`, `${'_'.repeat(30)}${String(n).padStart(2, '0')}`);
  const i = strike(g, 'list', { guild: guildDouble(g, [OFFICER]) });
  await execute(i);

  const first = lastEmbed(i);
  assert.equal(first.description.split('\n\n')[1].split('\n').length, 20);
  assertWithinEmbedLimits(first);

  i.collector.emit('collect', { customId: `strike-page-next-${i.id}`, user: user(OFFICER), deferUpdate: async () => {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = lastEmbed(i);
  assert.equal(second.description.split('\n\n')[1].split('\n').length, 20);
  assert.notEqual(second.description, first.description);
  assertWithinEmbedLimits(second);

  i.collector.emit('end');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(i.replies.at(-1).components[0].toJSON().components.every((button) => button.disabled));
  for (const payload of i.replies) assert.deepEqual(payload.allowedMentions, NO_PINGS);
});

test('embeds: check con 0 activos y 3 retirados lo dice bien, en verde', async () => {
  const g = await newGuild();
  for (let n = 0; n < 3; n++) await seed(g);
  for (let n = 0; n < 3; n++) await removeLatestStrike(g, { userId: TARGET, removedBy: OFFICER });
  const i = strike(g, 'check');
  await execute(i);
  const embed = lastEmbed(i);
  assert.equal(embed.color, 0x57f287);
  assert.match(embed.description, /Sin strikes activos/);
  assert.match(embed.description, /3 strikes retirados/);
});

test('embeds: motivos de 200 caracteres que se duplican al escapar no desbordan', async () => {
  const g = await newGuild();
  const reason = '*'.repeat(200);
  const client = clientDouble([g]);
  for (let n = 0; n < 30; n++) await seed(g, reason);

  const check = strike(g, 'check');
  await execute(check);
  assertWithinEmbedLimits(lastEmbed(check));
  assert.ok(check.replies.at(-1).components.length > 0, 'pagina');

  const add = strike(g, 'add', { reason, client });
  await execute(add);
  assertWithinEmbedLimits(lastEmbed(add));
  assertWithinEmbedLimits(client.sent[0].payload.embeds[0].toJSON());
});

test('embeds: los avisos de add, remove y clear no notifican a nadie', async () => {
  const g = await newGuild();
  const client = clientDouble([g]);
  await execute(strike(g, 'add', { reason: '@everyone', client }));
  await execute(strike(g, 'add', { reason: 'b', client }));
  await execute(strike(g, 'remove', { client }));
  await execute(strike(g, 'clear', { click: 'confirm', client }));
  assert.equal(client.sent.length, 4);
  for (const { payload } of client.sent) assert.deepEqual(payload.allowedMentions, NO_PINGS);
});

test('add: si falla la respuesta a Discord, el strike guardado queda en el canal de logs', { todo: 'S-3: el aviso va después de editReply' }, async () => {
  const g = await newGuild();
  const client = clientDouble([g]);
  await assert.rejects(execute(strike(g, 'add', { reason: 'x', client, failEdit: true })));
  assert.equal((await active(g)).length, 1);
  assert.equal(client.sent.length, 1);
});

// --- concurrencia y escritura ---

test('concurrencia: dos add simultáneos quedan los dos', async () => {
  const g = await newGuild();
  await Promise.all([execute(strike(g, 'add', { reason: 'uno' })), execute(strike(g, 'add', { reason: 'dos' }))]);
  assert.deepEqual((await active(g)).map((s) => s.reason).sort(), ['dos', 'uno']);
  const ids = (await loadStrikes(g)).map((s) => s.id);
  assert.equal(new Set(ids).size, 2);
});

test('escritura: matar el proceso a mitad deja strikes.json válido y un backup legible', async () => {
  const writer = fileURLToPath(new URL('./__fixtures__/strikeWriter.js', import.meta.url));
  for (let round = 0; round < 3; round++) {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'strikes-kill-'));
    const guildId = '920000000000000001';
    const child = spawn(process.execPath, [writer, guildId], {
      env: { ...process.env, DATA_DIR: dataDir },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    await new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('exit', () => reject(new Error('el escritor terminó antes de tiempo')));
    });
    child.removeAllListeners('exit');
    await new Promise((resolve) => setTimeout(resolve, 40 + round * 35));
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;

    const dir = path.join(dataDir, 'guilds', guildId);
    const current = JSON.parse(await readFile(path.join(dir, 'strikes.json'), 'utf8'));
    assert.ok(current.strikes.length >= 3);

    // S-4: el backup que se estaba copiando puede quedar cortado, así que se
    // exige que haya alguno legible, no que lo sean todos.
    const backups = (await readdir(path.join(dir, 'backups'))).filter((name) => name.startsWith('strikes-'));
    const readable = [];
    for (const name of backups) {
      try {
        readable.push(JSON.parse(await readFile(path.join(dir, 'backups', name), 'utf8')));
      } catch {
        // cortado por el kill
      }
    }
    assert.ok(readable.length >= 1);
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
  }
});

// --- informe semanal ---

function clock(t, now) {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  t.after(() => mock.timers.reset());
}

/** Apunta el retraso de cada setTimeout (ya simulado) que se programe. */
function spyDelays(t) {
  const delays = [];
  const mocked = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => {
    delays.push(ms);
    return mocked(fn, ms, ...args);
  };
  t.after(() => {
    globalThis.setTimeout = mocked;
  });
  return delays;
}

const reportGuild = (extra = {}) =>
  newGuild({ strikeReport: 'monday 12', strikeReportDesde: new Date(SLOT - 60 * DAY).toISOString(), ...extra });
const text = (entry) => entry.payload.embeds[0].toJSON().description;
const isScheduled = (guildId) => __scheduledGuildsForTests().includes(guildId);

beforeEach(() => {
  for (const id of __scheduledGuildsForTests()) cancelStrikeReport(id);
});

test('informe: con lastReportAt anterior a la cita, al arrancar sale ya y marcado como atrasado', async (t) => {
  const g = await reportGuild();
  await markReportSent(g, new Date(SLOT - 7 * DAY).toISOString());
  clock(t, SLOT + 5 * HOUR);
  const client = clientDouble([g]);
  await initializeStrikeReports(client);
  assert.equal(client.sent.length, 1);
  assert.match(text(client.sent[0]), /con retraso/);
  assert.ok(text(client.sent[0]).includes(`<t:${SLOT / 1000}:f>`), 'dice qué cita era');
});

test('informe: con lastReportAt posterior a la cita, no sale y queda para la siguiente', async (t) => {
  const g = await reportGuild();
  await markReportSent(g, new Date(SLOT + HOUR).toISOString());
  clock(t, SLOT + 5 * HOUR);
  const delays = spyDelays(t);
  const client = clientDouble([g]);
  await initializeStrikeReports(client);
  assert.equal(client.sent.length, 0);
  assert.ok(isScheduled(g));
  assert.equal(delays.at(-1), 7 * DAY - 5 * HOUR);
});

test('informe: tres reinicios el mismo día mandan uno solo', async (t) => {
  const g = await reportGuild();
  clock(t, SLOT + HOUR);
  const client = clientDouble([g]);
  for (let boot = 0; boot < 3; boot++) {
    await initializeStrikeReports(client);
    mock.timers.setTime(Date.now() + HOUR);
  }
  assert.equal(client.sent.length, 1);
});

test('informe: lunes a las 12 programado un miércoles apunta a los días que faltan', async (t) => {
  const g = await reportGuild();
  await markReportSent(g, new Date(SLOT).toISOString());
  const wednesday = new Date(2026, 10, 25, 10).getTime();
  clock(t, wednesday);
  const delays = spyDelays(t);
  const client = clientDouble([g]);
  await initializeStrikeReports(client);
  assert.equal(delays.at(-1), 5 * DAY + 2 * HOUR);

  mock.timers.tick(5 * DAY + 2 * HOUR - 1);
  await syncStrikeReport(client, g);
  assert.equal(client.sent.length, 0, 'un milisegundo antes todavía no');
  mock.timers.tick(1);
  await syncStrikeReport(client, g);
  assert.equal(client.sent.length, 1);
  assert.doesNotMatch(text(client.sent[0]), /con retraso/);
});

test('informe: sin canal de logs no programa nada y avisa una vez', async (t) => {
  const g = await reportGuild({ logChannelId: null });
  clock(t, SLOT + HOUR);
  const warn = mock.method(console, 'warn', () => {});
  t.after(() => warn.mock.restore());
  const client = clientDouble([g]);
  await initializeStrikeReports(client);
  assert.equal(client.sent.length, 0);
  assert.ok(!isScheduled(g));
  assert.equal(warn.mock.calls.filter((call) => String(call.arguments[0]).includes(g)).length, 1);
});

test('informe: si falla el envío, marca, reprograma y no reintenta al arrancar', async (t) => {
  const g = await reportGuild();
  clock(t, SLOT + HOUR);
  const error = mock.method(console, 'error', () => {});
  t.after(() => error.mock.restore());

  await initializeStrikeReports(clientDouble([g], { failSend: true }));
  assert.equal((await loadStrikesFile(g)).lastReportAt, new Date(SLOT + HOUR).toISOString());
  assert.ok(isScheduled(g));
  assert.ok(error.mock.calls.length >= 1, 'el fallo queda en el log');

  const next = clientDouble([g]);
  await initializeStrikeReports(next);
  assert.equal(next.sent.length, 0);
});

test('informe: el delta cuadra con lo añadido y quitado en el periodo', async (t) => {
  const g = await reportGuild();
  const previous = SLOT - 7 * DAY;
  clock(t, previous - DAY);
  // Antes del periodo: no cuentan como añadidos.
  await seed(g, 'antiguo-1');
  await seed(g, 'antiguo-2');
  mock.timers.setTime(previous);
  await markReportSent(g, new Date(previous).toISOString());
  // Justo en el límite: ya estaba en el informe anterior.
  await seed(g, 'en-el-limite');

  mock.timers.setTime(previous + DAY);
  await seed(g, 'nuevo-1');
  await seed(g, 'nuevo-2');
  await seed(g, 'nuevo-3');
  // Añadido y quitado dentro del periodo: cuenta en los dos lados.
  await removeLatestStrike(g, { userId: TARGET, removedBy: OFFICER });

  mock.timers.setTime(SLOT + 1000);
  const client = clientDouble([g]);
  await initializeStrikeReports(client);
  assert.match(text(client.sent[0]), /\*\*3\*\* añadidos, \*\*1\*\* retirado/);
  assert.match(text(client.sent[0]), /\*\*5\*\* strikes en total/);
});

test('informe: desactivado no recibe nada ni tiene temporizador', async (t) => {
  const g = await newGuild();
  await seed(g);
  clock(t, SLOT + HOUR);
  const client = clientDouble([g]);
  await initializeStrikeReports(client);
  assert.equal(client.sent.length, 0);
  assert.ok(!isScheduled(g));
});

test('informe: salir de un servidor cancela su temporizador y no el de otro', async (t) => {
  const [a, b] = [await reportGuild(), await reportGuild()];
  await markReportSent(a, new Date(SLOT).toISOString());
  await markReportSent(b, new Date(SLOT).toISOString());
  clock(t, SLOT + HOUR);
  const client = clientDouble([a, b]);
  await initializeStrikeReports(client);

  // Lo mismo que hace index.js con GuildDelete.
  assert.equal(await onGuildRemoved({ id: a, name: 'a', available: true }), true);
  cancelStrikeReport(a);
  assert.ok(!isScheduled(a));
  assert.ok(isScheduled(b));

  mock.timers.tick(7 * DAY);
  await syncStrikeReport(client, b);
  assert.deepEqual(client.sent.map((entry) => entry.channelId), [logOf(b)]);
});

test('informe: una caída de Discord (available=false) no cuenta como salir', async () => {
  const g = await reportGuild();
  assert.equal(await onGuildRemoved({ id: g, name: 'g', available: false }), false);
});

test('informe: no notifica a nadie, tampoco repartido en varios mensajes', async (t) => {
  const g = await reportGuild();
  clock(t, SLOT - DAY);
  for (let n = 0; n < 120; n++) await seed(g, 'x', `6000000000000${String(n).padStart(5, '0')}`);
  mock.timers.setTime(SLOT + 1000);
  const client = clientDouble([g]);
  await initializeStrikeReports(client);
  assert.ok(client.sent.length > 1);
  for (const { payload } of client.sent) {
    assert.deepEqual(payload.allowedMentions, NO_PINGS);
    assert.equal(payload.content, undefined);
    assertWithinEmbedLimits(payload.embeds[0].toJSON());
  }
});
