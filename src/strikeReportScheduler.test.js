import { test, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Con cambio de hora real: es donde falla sumar 7 días en milisegundos.
process.env.TZ = 'Europe/Madrid';
const DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'strike-report-test-'));
process.env.DATA_DIR = DATA_DIR;

const { PermissionFlagsBits, ChannelType } = await import('discord.js');
const { getConfig, setConfig, rutaDe } = await import('./services/guildStore.js');
const { addStrike, removeLatestStrike, loadStrikesFile, markReportSent } = await import('./services/strikesStore.js');
const { parseSchedule, slotsAround, overdueSlot } = await import('./services/strikeReportSchedule.js');
const { initializeStrikeReports, syncStrikeReport, cancelStrikeReport, __scheduledGuildsForTests } = await import('./strikeReportScheduler.js');
const { execute: executeConfig, data: configData } = await import('./commands/config.js');
const { buildConfigViewEmbed } = await import('./ui/configEmbed.js');

after(() => rm(DATA_DIR, { recursive: true, force: true }));

const MONDAY_12 = 'monday 12';
// Lunes 23/11/2026 a las 12:00 en Madrid (UTC+1).
const SLOT = new Date(2026, 10, 23, 12).getTime();
const WEEK = 7 * 24 * 60 * 60 * 1000;
const USER = '100000000000000002';
const OFFICER = '100000000000000001';

let nextGuild = 800000000000000000n;
const newGuildId = () => String(++nextGuild);

function makeClient(guildIds, { failSend = false } = {}) {
  const sent = [];
  return {
    sent,
    guilds: {
      cache: new Map(guildIds.map((id) => [id, { id, available: true, members: { cache: new Map([[USER, {}]]), fetch: async () => new Map() } }])),
    },
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

async function enabledGuild(extra = {}) {
  const guildId = newGuildId();
  await setConfig(guildId, {
    idioma: 'es',
    logChannelId: `log-${guildId}`,
    strikeReport: MONDAY_12,
    strikeReportDesde: new Date(SLOT - 30 * 24 * 3600 * 1000).toISOString(),
    ...extra,
  });
  return guildId;
}

const description = (entry) => entry.payload.embeds[0].toJSON().description;

// Reloj simulado solo para Date y setTimeout: el disco sigue siendo real.
function clockAt(t, now) {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  t.after(() => mock.timers.reset());
}

async function waitFor(condition, ms = 2000) {
  const start = performance.now();
  while (performance.now() - start < ms) {
    if (await condition()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return false;
}

beforeEach(() => {
  for (const id of __scheduledGuildsForTests()) cancelStrikeReport(id);
});

// --- calendario ---

test('la cita es día y hora fijos, también a través del cambio de hora', () => {
  const schedule = parseSchedule('sunday 12');
  // 25/10/2026: en Madrid ese domingo dura 25 horas.
  const before = new Date(2026, 9, 24, 20).getTime();
  const { next } = slotsAround(before, schedule);
  const { next: following } = slotsAround(next, schedule);
  assert.equal(new Date(next).getHours(), 12);
  assert.equal(new Date(following).getHours(), 12);
  assert.equal(new Date(following).getDay(), 0);
  // Del lunes 19 al 26 de octubre hay cambio de hora: esa semana mide 169 h.
  const monday = parseSchedule(MONDAY_12);
  const a = slotsAround(new Date(2026, 9, 13).getTime(), monday).next;
  const b = slotsAround(a, monday).next;
  assert.equal(b - a, WEEK + 3600_000);
  assert.equal(new Date(b).getHours(), 12);
});

test('previous es <= ahora y next es > ahora, justo en la cita incluida', () => {
  const schedule = parseSchedule(MONDAY_12);
  assert.deepEqual(slotsAround(SLOT, schedule), { previous: SLOT, next: SLOT + WEEK });
  assert.deepEqual(slotsAround(SLOT - 1, schedule), { previous: SLOT - WEEK, next: SLOT });
});

test('una cita anterior a activar el horario no cuenta como atrasada', () => {
  const schedule = parseSchedule(MONDAY_12);
  const tuesday = SLOT + 24 * 3600_000;
  assert.equal(overdueSlot(tuesday, schedule, null, new Date(SLOT + 3600_000).toISOString()), null);
  assert.equal(overdueSlot(tuesday, schedule, null, new Date(SLOT - 3600_000).toISOString()), SLOT);
  assert.equal(overdueSlot(tuesday, schedule, new Date(SLOT).toISOString(), null), null);
});

// --- arranque ---

test('al arrancar tras saltarse la cita manda el informe con nota de retraso, y solo una vez', async (t) => {
  const guildId = await enabledGuild();
  await addStrike(guildId, { userId: USER, userName: 'n', reason: 'x', addedBy: OFFICER });
  clockAt(t, SLOT + 3600_000);
  const client = makeClient([guildId]);

  await initializeStrikeReports(client);
  assert.equal(client.sent.length, 1);
  assert.match(description(client.sent[0]), /con retraso/);
  assert.deepEqual(client.sent[0].payload.allowedMentions, { parse: [] });
  assert.equal((await loadStrikesFile(guildId)).lastReportAt, new Date(SLOT + 3600_000).toISOString());

  // Otro despliegue poco después: ya está cubierta.
  await initializeStrikeReports(client);
  assert.equal(client.sent.length, 1);
  assert.ok(__scheduledGuildsForTests().includes(guildId));
});

test('desplegar cada semana antes de la cita no impide el informe', async (t) => {
  const guildId = await enabledGuild();
  await markReportSent(guildId, new Date(SLOT - WEEK).toISOString());
  clockAt(t, SLOT - 3600_000);
  await initializeStrikeReports(makeClient([guildId])); // proceso que muere

  mock.timers.setTime(SLOT + 60_000);
  const client = makeClient([guildId]);
  await initializeStrikeReports(client);
  assert.equal(client.sent.length, 1);
  assert.match(description(client.sent[0]), /con retraso/);
});

test('el temporizador manda a la hora exacta, sin nota, y reprograma el siguiente', async (t) => {
  const guildId = await enabledGuild();
  await markReportSent(guildId, new Date(SLOT - WEEK).toISOString());
  clockAt(t, SLOT - 1000);
  const client = makeClient([guildId]);
  await initializeStrikeReports(client);
  assert.equal(client.sent.length, 0);

  mock.timers.tick(1000);
  // Va detrás del disparo en la fila del servidor: al volver, ya ha terminado.
  await syncStrikeReport(client, guildId);
  assert.equal((await loadStrikesFile(guildId)).lastReportAt, new Date(SLOT).toISOString());
  assert.equal(client.sent.length, 1);
  assert.doesNotMatch(description(client.sent[0]), /con retraso/);

  assert.ok(__scheduledGuildsForTests().includes(guildId));
  mock.timers.tick(WEEK);
  await syncStrikeReport(client, guildId);
  assert.equal(client.sent.length, 2, 'la semana siguiente vuelve a salir');
});

test('si falla el envío actualiza lastReportAt, reprograma y no reintenta al arrancar', async (t) => {
  const guildId = await enabledGuild();
  clockAt(t, SLOT + 3600_000);
  const originalError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalError;
  });

  await initializeStrikeReports(makeClient([guildId], { failSend: true }));
  assert.equal((await loadStrikesFile(guildId)).lastReportAt, new Date(SLOT + 3600_000).toISOString());
  assert.ok(__scheduledGuildsForTests().includes(guildId));

  const client = makeClient([guildId]);
  await initializeStrikeReports(client);
  assert.equal(client.sent.length, 0);
});

test('un strikes.json roto no se sobrescribe y el temporizador sigue vivo', async (t) => {
  const guildId = await enabledGuild();
  const file = rutaDe(guildId, 'strikes.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'no es json');
  clockAt(t, SLOT + 3600_000);
  const originalError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalError;
  });

  await initializeStrikeReports(makeClient([guildId]));
  assert.equal(await readFile(file, 'utf8'), 'no es json');
  assert.ok(__scheduledGuildsForTests().includes(guildId));
});

test('desactivado por defecto o sin canal de logs: ni manda ni programa', async (t) => {
  const off = newGuildId();
  await setConfig(off, { logChannelId: `log-${off}` });
  const noLogs = await enabledGuild({ logChannelId: null });
  clockAt(t, SLOT + 3600_000);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  t.after(() => {
    console.warn = originalWarn;
  });

  const client = makeClient([off, noLogs]);
  await initializeStrikeReports(client);
  assert.equal(client.sent.length, 0);
  assert.ok(!__scheduledGuildsForTests().includes(off));
  assert.ok(!__scheduledGuildsForTests().includes(noLogs));
  assert.equal(warnings.filter((w) => w.includes(noLogs)).length, 1);
  assert.equal(warnings.filter((w) => w.includes(off)).length, 0);
});

test('cada servidor lleva su temporizador, y al salir se cancela solo el suyo', async (t) => {
  const a = await enabledGuild();
  const b = await enabledGuild({ strikeReport: 'friday 20' });
  await markReportSent(a, new Date(SLOT).toISOString());
  await markReportSent(b, new Date(SLOT).toISOString());
  clockAt(t, SLOT + 1000);
  const client = makeClient([a, b]);
  await initializeStrikeReports(client);
  assert.ok(__scheduledGuildsForTests().includes(a) && __scheduledGuildsForTests().includes(b));

  cancelStrikeReport(a);
  assert.ok(!__scheduledGuildsForTests().includes(a));
  mock.timers.tick(WEEK);
  assert.ok(await waitFor(() => client.sent.some((s) => s.channelId === `log-${b}`)));
  assert.ok(!client.sent.some((s) => s.channelId === `log-${a}`));
});

test('apagar el informe cancela el temporizador', async (t) => {
  const guildId = await enabledGuild();
  await markReportSent(guildId, new Date(SLOT).toISOString());
  clockAt(t, SLOT + 1000);
  const client = makeClient([guildId]);
  await initializeStrikeReports(client);
  await setConfig(guildId, { strikeReport: null });
  await syncStrikeReport(client, guildId);
  assert.ok(!__scheduledGuildsForTests().includes(guildId));
});

// --- contenido ---

test('el informe lleva totales, usuarios y lo cambiado desde el anterior', async (t) => {
  const guildId = await enabledGuild();
  const gone = '100000000000000009';
  clockAt(t, SLOT - 10 * 24 * 3600_000);
  await addStrike(guildId, { userId: USER, userName: 'n', reason: 'viejo', addedBy: OFFICER });
  mock.timers.setTime(SLOT - WEEK);
  await markReportSent(guildId, new Date(SLOT - WEEK).toISOString());
  mock.timers.setTime(SLOT - 3600_000);
  await addStrike(guildId, { userId: USER, userName: 'n', reason: 'a', addedBy: OFFICER });
  await addStrike(guildId, { userId: gone, userName: 'se_marcho', reason: 'b', addedBy: OFFICER });
  await addStrike(guildId, { userId: gone, userName: 'se_marcho', reason: 'c', addedBy: OFFICER });
  await removeLatestStrike(guildId, { userId: gone, removedBy: OFFICER });

  mock.timers.setTime(SLOT + 1000);
  const client = makeClient([guildId]);
  await initializeStrikeReports(client);
  const text = description(client.sent[0]);
  assert.match(text, /\*\*2\*\* usuarios/);
  assert.match(text, /\*\*3\*\* strikes/);
  assert.match(text, /\*\*3\*\* añadidos, \*\*1\*\* retirado/);
  assert.ok(text.indexOf(`<@${USER}>`) < text.indexOf('se\\_marcho'), 'de más a menos');
  assert.match(text, /se fue del servidor/);
});

test('sin strikes activos se manda igual, corto y en verde', async (t) => {
  const guildId = await enabledGuild();
  clockAt(t, SLOT + 1000);
  const client = makeClient([guildId]);
  await initializeStrikeReports(client);
  const embed = client.sent[0].payload.embeds[0].toJSON();
  assert.equal(embed.color, 0x57f287);
  assert.match(embed.description, /Nadie tiene strikes/);
});

test('con muchos usuarios se reparte en varios mensajes sin perder ninguno', async (t) => {
  const guildId = await enabledGuild();
  clockAt(t, SLOT - 1000);
  for (let n = 0; n < 150; n++) {
    await addStrike(guildId, { userId: `3000000000000${String(n).padStart(5, '0')}`, userName: 'n', reason: 'x', addedBy: OFFICER });
  }
  mock.timers.setTime(SLOT + 1000);
  const client = makeClient([guildId]);
  client.guilds.cache.get(guildId).members.fetch = async ({ user }) => new Map(user.map((id) => [id, {}]));
  await initializeStrikeReports(client);
  assert.ok(client.sent.length > 1);
  const text = client.sent.map(description).join('\n');
  assert.equal(text.match(/<@3\d+>/g).length, 150);
  for (const entry of client.sent) assert.ok(description(entry).length <= 4096);
});

// --- /config strike-report ---

function configInteraction(guildId, options, client = makeClient([guildId])) {
  const edits = [];
  return {
    guildId,
    guild: { preferredLocale: 'es-ES', roles: { cache: new Map() }, channels: { cache: new Map() } },
    locale: 'es-ES',
    user: { id: OFFICER, tag: 'Admin#0001' },
    memberPermissions: { has: (flag) => flag === PermissionFlagsBits.Administrator },
    client,
    options: {
      getSubcommand: () => 'strike-report',
      getString: (name) => options[name] ?? null,
      getInteger: (name) => options[name] ?? null,
    },
    reply: async () => {},
    deferReply: async () => {},
    editReply: async (payload) => edits.push(payload),
    edits,
  };
}

test('/config strike-report guarda, programa, enseña la zona y off lo apaga', async () => {
  const guildId = newGuildId();
  await setConfig(guildId, { logChannelId: `log-${guildId}`, idioma: 'es' });

  const on = configInteraction(guildId, { day: 'monday', hour: 12 });
  await executeConfig(on);
  assert.equal((await getConfig(guildId)).strikeReport, MONDAY_12);
  assert.ok((await getConfig(guildId)).strikeReportDesde);
  assert.ok(__scheduledGuildsForTests().includes(guildId));
  assert.match(on.edits[0].embeds[0].toJSON().description, /Europe\/Madrid/);

  await executeConfig(configInteraction(guildId, { day: 'off' }));
  const config = await getConfig(guildId);
  assert.equal(config.strikeReport, null);
  assert.equal(config.strikeReportDesde, null);
  assert.ok(!__scheduledGuildsForTests().includes(guildId));
});

test('/config strike-report con día y sin hora se rechaza', async () => {
  const guildId = newGuildId();
  const i = configInteraction(guildId, { day: 'monday' });
  await executeConfig(i);
  assert.equal((await getConfig(guildId)).strikeReport, null);
  assert.match(i.edits[0].embeds[0].toJSON().description, /hora/);
});

test('el comando ofrece los 7 días y off, y hora 0-23', () => {
  const sub = configData.toJSON().options.find((o) => o.name === 'strike-report');
  const [day, hour] = sub.options;
  assert.deepEqual(day.choices.map((c) => c.value), ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'off']);
  assert.deepEqual([hour.required, hour.min_value, hour.max_value], [false, 0, 23]);
  assert.equal(hour.type, 4);
  assert.equal(ChannelType.GuildText, 0);
});

test('tener el informe apagado no sale como algo que falta en /config view', async () => {
  const guildId = newGuildId();
  const embed = buildConfigViewEmbed({ config: await getConfig(guildId), lang: 'es' }).toJSON();
  assert.ok(!embed.fields.at(-1).value.includes('strike-report'));
});
