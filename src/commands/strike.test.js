import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'strike-test-'));
process.env.DATA_DIR = DATA_DIR;

const { setConfig, rutaDe } = await import('../services/guildStore.js');
const { addStrike, loadStrikes, activeStrikes, clearStrikes } = await import('../services/strikesStore.js');
const { execute, data } = await import('./strike.js');
const { resolvePresence } = await import('../services/memberPresence.js');
const { checkPages } = await import('../ui/strikesEmbed.js');

const GUILD = '700000000000000001';
const OTHER_GUILD = '700000000000000002';
const OFFICER = '100000000000000001';
const TARGET = '100000000000000002';
const LOG_CHANNEL = '300000000000000001';

const user = (id, extra = {}) => ({ id, username: `user${id.slice(-3)}`, tag: `user${id.slice(-3)}`, bot: false, ...extra });

let logSent;
const client = {
  channels: {
    fetch: async () => ({
      guildId: GUILD,
      isTextBased: () => true,
      send: async (payload) => logSent.push(payload),
    }),
  },
};

/** Interacción mínima. `click` responde al botón de confirmación. */
function interaction({ sub, target = user(TARGET), reason = null, roles = ['officer'], click, member = {}, guild, guildId = GUILD }) {
  const replies = [];
  const collector = new EventEmitter();
  const message = {
    createMessageComponentCollector: (options) => {
      message.collectorOptions = options;
      return collector;
    },
    awaitMessageComponent: async ({ filter }) => {
      if (!click) throw new Error('timeout');
      const button = {
        user: { id: OFFICER },
        customId: `strike-clear-${click}-1`,
        deferUpdate: async () => {},
        update: async (p) => replies.push(p),
        editReply: async (p) => replies.push(p),
      };
      assert.ok(filter(button));
      return button;
    },
  };
  return {
    id: '1',
    guildId,
    guild: guild ?? { roles: { cache: new Map([['officer', {}]]) }, members: { cache: new Map() } },
    locale: 'es-ES',
    client,
    user: user(OFFICER),
    member: { roles: { cache: new Map(roles.map((r) => [r, {}])) } },
    options: {
      getSubcommand: () => sub,
      getUser: () => target,
      getString: () => reason,
      getMember: () => (member === null ? null : { id: target.id, ...member }),
    },
    replies,
    collector,
    message,
    reply: async (p) => replies.push(p),
    deferReply: async () => {},
    editReply: async (p) => {
      replies.push(p);
      return message;
    },
  };
}

/** Los avisos a logs no se esperan: se comprueba que acaban llegando. */
async function until(condition, ms = 2000) {
  const start = performance.now();
  while (performance.now() - start < ms) {
    if (condition()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return false;
}

const lastEmbed = (i) => i.replies.at(-1).embeds[0].toJSON();

before(async () => {
  await setConfig(GUILD, { officerRoleId: 'officer', logChannelId: LOG_CHANNEL, idioma: 'es' });
  await setConfig(OTHER_GUILD, { officerRoleId: 'officer' });
});
after(() => rm(DATA_DIR, { recursive: true, force: true }));
beforeEach(async () => {
  logSent = [];
  await rm(rutaDe(GUILD, 'strikes.json'), { force: true });
  await rm(rutaDe(OTHER_GUILD, 'strikes.json'), { force: true });
});

const seed = (reason, userId = TARGET) => addStrike(GUILD, { userId, userName: 'nombre', reason, addedBy: OFFICER });

test('el comando usa una opción USER y limita el motivo a 200', () => {
  const json = data.toJSON();
  const add = json.options.find((o) => o.name === 'add');
  assert.equal(add.options[0].type, 6);
  assert.equal(add.options[1].required, true);
  assert.equal(add.options[1].max_length, 200);
  assert.equal(json.name_localizations, undefined);
});

test('quien no es oficial no puede usar ningún subcomando', async () => {
  for (const sub of ['add', 'remove', 'clear', 'check', 'list']) {
    const i = interaction({ sub, reason: 'x', roles: [] });
    await execute(i);
    assert.equal(lastEmbed(i).title, 'Sin permiso');
  }
  assert.deepEqual(await loadStrikes(GUILD), []);
});

test('rechaza bots, a uno mismo y un motivo de solo espacios', async () => {
  for (const params of [{ target: user(TARGET, { bot: true }), reason: 'x' }, { target: user(OFFICER), reason: 'x' }, { reason: '   ' }]) {
    const i = interaction({ sub: 'add', ...params });
    await execute(i);
    assert.equal(lastEmbed(i).title, 'No se puede hacer');
  }
  assert.deepEqual(await loadStrikes(GUILD), []);
});

test('add guarda el evento con el formato pedido, responde con el total y avisa sin pingar', async () => {
  const i = interaction({ sub: 'add', reason: '  No vino a la ZvZ @everyone ' });
  await execute(i);

  const raw = JSON.parse(await readFile(rutaDe(GUILD, 'strikes.json'), 'utf8'));
  assert.equal(raw.version, 1);
  const [strike] = raw.strikes;
  assert.match(strike.id, /^stk_\d+_[0-9a-f]{4}$/);
  assert.equal(strike.reason, 'No vino a la ZvZ @everyone');
  assert.deepEqual([strike.removedAt, strike.removedBy, strike.removedReason], [null, null, null]);
  assert.match(lastEmbed(i).description, /\*\*1\*\* strike activo/);
  assert.deepEqual(i.replies.at(-1).allowedMentions, { parse: [] });
  assert.ok(await until(() => logSent.length === 1));
  assert.deepEqual(logSent[0].allowedMentions, { parse: [] });
});

test('remove quita el más reciente, conserva el evento y enseña el motivo original', async () => {
  await seed('primero');
  await new Promise((r) => setTimeout(r, 2));
  await seed('segundo');

  const i = interaction({ sub: 'remove', reason: 'apelación' });
  await execute(i);

  const strikes = await loadStrikes(GUILD);
  assert.equal(strikes.length, 2);
  const removed = strikes.find((s) => s.reason === 'segundo');
  assert.equal(removed.removedBy, OFFICER);
  assert.equal(removed.removedReason, 'apelación');
  assert.ok(removed.removedAt);
  assert.equal(strikes.find((s) => s.reason === 'primero').removedAt, null);
  assert.match(lastEmbed(i).description, /segundo/);
  assert.match(lastEmbed(i).description, /Le queda \*\*1\*\*/);
  assert.ok(await until(() => logSent.length === 1));
});

test('remove sin strikes activos lo dice y no escribe ni avisa', async () => {
  const i = interaction({ sub: 'remove' });
  await execute(i);
  assert.match(lastEmbed(i).description, /no tiene strikes activos/);
  assert.equal(logSent.length, 0);
  await assert.rejects(readFile(rutaDe(GUILD, 'strikes.json')));
});

test('clear confirmado retira todos; sin pulsar o cancelando no toca nada', async () => {
  await seed('a');
  await seed('b');

  for (const click of [undefined, 'cancel']) {
    await execute(interaction({ sub: 'clear', click }));
    assert.equal(activeStrikes(await loadStrikes(GUILD), TARGET).length, 2);
  }
  assert.equal(logSent.length, 0);

  const i = interaction({ sub: 'clear', click: 'confirm' });
  await execute(i);
  assert.equal(activeStrikes(await loadStrikes(GUILD), TARGET).length, 0);
  assert.equal((await loadStrikes(GUILD)).length, 2);
  assert.ok(await until(() => logSent.length === 1));
});

test('clear no perdona un strike puesto mientras se esperaba la confirmación', async () => {
  const { strike } = await seed('visto');
  await seed('nuevo');
  const result = await clearStrikes(GUILD, { userId: TARGET, removedBy: OFFICER, ids: [strike.id] });
  assert.deepEqual(result, { cleared: 1, activeCount: 1 });
});

test('check: colores, recuento de retirados y marca de quien se fue', async () => {
  let i = interaction({ sub: 'check' });
  await execute(i);
  assert.equal(lastEmbed(i).color, 0x57f287);

  await seed('uno');
  i = interaction({ sub: 'check' });
  await execute(i);
  assert.equal(lastEmbed(i).color, 0xfee75c);

  await seed('dos');
  await seed('tres');
  await execute(interaction({ sub: 'remove' }));
  await seed('cuatro');
  i = interaction({ sub: 'check', member: null });
  await execute(i);
  const embed = lastEmbed(i);
  assert.equal(embed.color, 0xed4245);
  assert.match(embed.description, /1 strike retirado/);
  assert.match(embed.description, /nombre \*\(se fue del servidor\)\*/);
});

test('check parte en páginas los motivos largos sin pasarse del límite del embed', () => {
  const active = Array.from({ length: 40 }, () => ({
    reason: '*'.repeat(200),
    addedBy: OFFICER,
    addedAt: '2026-11-22T18:30:00.000Z',
  }));
  const pages = checkPages(active, 'es');
  assert.ok(pages.length > 1);
  for (const page of pages) assert.ok(page.length <= 3800);
});

test('list: de más a menos, 20 por página, botones que caducan deshabilitados', async () => {
  for (let n = 0; n < 25; n++) await seed('x', `2000000000000000${String(n).padStart(2, '0')}`);
  const top = '200000000000000099';
  await seed('x', top);
  await seed('y', top);

  const members = { cache: new Map([[top, {}]]), fetch: async ({ user: ids }) => new Map(ids.map((id) => [id, {}])) };
  const i = interaction({ sub: 'list', guild: { roles: { cache: new Map([['officer', {}]]) }, members } });
  await execute(i);

  const first = lastEmbed(i);
  assert.match(first.description, /\*\*26\*\* usuarios/);
  assert.match(first.description, /\*\*27\*\* strikes/);
  assert.ok(first.description.split('\n\n')[1].startsWith(`<@${top}>`));
  assert.equal(first.description.split('\n\n')[1].split('\n').length, 20);
  assert.equal(i.message.collectorOptions.time, 300_000);

  const click = { customId: 'strike-page-next-1', user: { id: OFFICER }, deferUpdate: async () => {} };
  i.collector.emit('collect', click);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(lastEmbed(i).description.split('\n\n')[1].split('\n').length, 6);

  i.collector.emit('end');
  await new Promise((r) => setTimeout(r, 10));
  const buttons = i.replies.at(-1).components[0].toJSON().components;
  assert.ok(buttons.every((b) => b.disabled));
});

test('un oficial no puede quitarse sus propios strikes, ni con remove ni con clear', async () => {
  await seed('mío', OFFICER);
  for (const sub of ['remove', 'clear']) {
    const i = interaction({ sub, target: user(OFFICER), click: 'confirm' });
    await execute(i);
    assert.equal(lastEmbed(i).title, 'No se puede hacer');
  }
  assert.equal(activeStrikes(await loadStrikes(GUILD), OFFICER).length, 1);
  assert.equal(logSent.length, 0);
});

test('check: sin rol se ven los propios, en efímero, pero no los de otro', async () => {
  await seed('mío', OFFICER);
  await seed('ajeno');

  const own = interaction({ sub: 'check', target: user(OFFICER), roles: [] });
  await execute(own);
  assert.match(lastEmbed(own).description, /mío/);

  const other = interaction({ sub: 'check', roles: [] });
  await execute(other);
  assert.equal(lastEmbed(other).title, 'Sin permiso');
  assert.doesNotMatch(lastEmbed(other).description, /ajeno/);
  assert.equal(other.replies.at(-1).ephemeral, true);
});

test('check: un oficial puede ver los de cualquiera', async () => {
  await seed('ajeno');
  const i = interaction({ sub: 'check' });
  await execute(i);
  assert.match(lastEmbed(i).description, /ajeno/);
});

test('list sigue siendo solo para oficiales', async () => {
  await seed('ajeno');
  const i = interaction({ sub: 'list', roles: [] });
  await execute(i);
  assert.equal(lastEmbed(i).title, 'Sin permiso');
  assert.doesNotMatch(JSON.stringify(lastEmbed(i)), new RegExp(TARGET));
});

test('list vacío en verde', async () => {
  const i = interaction({ sub: 'list' });
  await execute(i);
  assert.equal(lastEmbed(i).color, 0x57f287);
  assert.match(lastEmbed(i).description, /Nadie/);
});

test('si Discord no responde, nadie se marca como ido', async () => {
  const guild = { members: { cache: new Map(), fetch: async () => { throw new Error('timeout'); } } };
  const { present, gone, unknown } = await resolvePresence(guild, [TARGET]);
  assert.ok(unknown.has(TARGET));
  assert.ok(!present.has(TARGET) && !gone.has(TARGET));
});

test('un fichero roto hace fallar el comando y no se sobrescribe', async () => {
  const file = rutaDe(GUILD, 'strikes.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '{"version":99,"strikes":[]}');
  await assert.rejects(execute(interaction({ sub: 'add', reason: 'x' })));
  assert.equal(await readFile(file, 'utf8'), '{"version":99,"strikes":[]}');
});

test('hace backup antes de sobrescribir y las escrituras simultáneas no se pierden', async () => {
  await Promise.all(Array.from({ length: 15 }, (_, n) => seed(`r${n}`)));
  assert.equal((await loadStrikes(GUILD)).length, 15);
  const backups = (await readdir(rutaDe(GUILD, 'backups'))).filter((f) => f.startsWith('strikes-'));
  assert.ok(backups.length >= 1 && backups.length <= 10);
});

test('los strikes de un servidor no se ven en otro', async () => {
  await seed('solo aquí');
  assert.deepEqual(await loadStrikes(OTHER_GUILD), []);
});
