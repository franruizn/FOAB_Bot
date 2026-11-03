import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// /raffle con winners y message, de punta a punta: el comando real, el
// resolveRaffle real y los embeds reales, con las tiradas inyectadas
// (withRolls) para que los empates sean deterministas.

const DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'raffle-options-test-'));
process.env.DATA_DIR = DATA_DIR;

const { setConfig } = await import('./services/guildStore.js');
const { loadRaffles } = await import('./services/rafflesStore.js');
const { execute } = await import('./commands/sorteo.js');
const { resolveRaffle } = await import('./raffleScheduler.js');
const { buildRaffleResultsEmbed } = await import('./ui/raffleEmbed.js');
const { FakeUser, FakeMessage, FakeChannel, FakeGuild, makeClient, makeInteraction, withRolls, withFrozenClock, FIXED_NOW } = await import(
  './__fixtures__/raffleHarness.js'
);

const GUILD = '400000000000000001';
const GUILD_RAFFLE_ROLE = '400000000000000002';

before(async () => {
  await setConfig(GUILD, { officerRoleId: 'officer-role', idioma: 'es' });
  await setConfig(GUILD_RAFFLE_ROLE, { officerRoleId: 'officer-role', idioma: 'es', raffleRoleId: 'raffle-role' });
});
after(() => rm(DATA_DIR, { recursive: true, force: true }));

let channelCount = 0;
const newChannel = () => new FakeChannel(`chan-${++channelCount}`);

async function announce({ guildId = GUILD, integers = {}, strings = {}, role = null } = {}) {
  const channel = newChannel();
  const interaction = makeInteraction({ guildId, channel, integers, strings, role });
  await withFrozenClock(() => execute(interaction));
  const stored = (await loadRaffles(guildId)).find((r) => r.channelId === channel.id) ?? null;
  return { interaction, channel, sent: channel.sent, stored, error: interaction.replies[0]?.embeds?.[0]?.toJSON().description };
}

// Snowflakes de verdad (19 cifras): el límite de 1024 se mide con menciones
// del tamaño real, no con "p1".
const snowflake = (i) => String(1_234_567_890_123_456_000n + BigInt(i));
const users = (n) => Array.from({ length: n }, (_, i) => snowflake(i + 1));

async function resolveWith({ reactors, rolls, winners, message = null, guildId = GUILD, roleId = null, guild = null }) {
  const channel = newChannel();
  const announcement = new FakeMessage(`${channel.id}-announcement`);
  if (reactors.length > 0) announcement.addReaction('🎉', reactors.map((id) => new FakeUser(id)));
  channel.store.set(announcement.id, announcement);
  const raffle = { id: `r-${channel.id}`, guildId, channelId: channel.id, messageId: announcement.id, endsAt: FIXED_NOW, creatorId: 'creator-1', roleId, winners, message };
  await withRolls(rolls, () => resolveRaffle(makeClient({ channels: [channel], guilds: guild ? [guild] : [] }), raffle));
  const [payload] = channel.sent;
  return { content: payload.content, embed: payload.embeds[0].toJSON() };
}

// Los ganadores, en orden, sacados de la descripción (el field de tiradas
// también lista a los no ganadores).
function winnerIds(embed) {
  return [...embed.description.split('\n\n')[0].matchAll(/<@(\d+|\w+)>/g)].map((m) => m[1]);
}

// El mensaje del anuncio va en su propio embed, no en el texto.
function announcedMessage(payload) {
  return payload.embeds?.[0]?.toJSON().fields?.[0]?.value ?? null;
}

function embedLength(embed) {
  return (
    (embed.title?.length ?? 0) +
    (embed.description?.length ?? 0) +
    (embed.footer?.text.length ?? 0) +
    (embed.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0)
  );
}

// ============================================================
// NO ROMPER: rol restrictivo combinado con las opciones nuevas
// ============================================================

test('rol restrictivo + winners + message: el anuncio explica el rol, el mensaje va aparte y solo pinga ese rol', async () => {
  const { sent, stored } = await announce({
    guildId: GUILD_RAFFLE_ROLE,
    role: { id: 'party-role' },
    integers: { winners: 3 },
    strings: { message: 'Premio: montura' },
  });
  assert.equal(
    sent[0].content,
    '<@&party-role> <@creator-1> ha comenzado un sorteo que terminará <t:1793730600:R>.\n\n🏆 **3 ganadores**\n\n' +
      'Reacciona con 🎉 para participar (solo miembros de <@&party-role>).',
  );
  assert.equal(announcedMessage(sent[0]), 'Premio: montura');
  assert.deepEqual(sent[0].allowedMentions, { parse: [], roles: ['party-role'] });
  assert.equal(stored.roleId, 'party-role');
  assert.equal(stored.winners, 3);
  assert.equal(stored.message, 'Premio: montura');
});

test('rol restrictivo + winners: solo quienes tienen el rol pueden ganar, y el footer cuenta los descartes', async () => {
  const guild = new FakeGuild(GUILD, { roleIds: ['party-role'], members: { a: ['party-role'], b: [], c: ['party-role'], d: ['party-role'], e: [] } });
  // b y e no tienen el rol: no tiran. a, c, d tiran en ese orden.
  const { embed } = await resolveWith({ reactors: ['a', 'b', 'c', 'd', 'e'], rolls: [10, 90, 50], winners: 2, roleId: 'party-role', guild });
  assert.deepEqual(winnerIds(embed), ['c', 'd']);
  assert.equal(embed.footer.text, 'Tiradas 1–100 · 3 de 5 participantes válidos');
});

// ============================================================
// GANADORES
// ============================================================

test('winners:3 con 10 participantes: 3 ganadores distintos, los 3 de tirada más alta', async () => {
  const ids = users(10);
  const rolls = [12, 88, 45, 97, 3, 61, 74, 29, 90, 55];
  const { embed, content } = await resolveWith({ reactors: ids, rolls, winners: 3 });
  const expected = [ids[3], ids[8], ids[1]]; // 97, 90, 88
  assert.deepEqual(winnerIds(embed), expected);
  assert.equal(new Set(winnerIds(embed)).size, 3);
  assert.equal(content, `<@${expected[0]}>, <@${expected[1]}> y <@${expected[2]}> han ganado el sorteo de <@creator-1>`);
  assert.doesNotMatch(embed.description, /Desempate/);
});

test('winners:3 con 2 participantes: ganan los 2 y el embed lo dice', async () => {
  const { embed, content } = await resolveWith({ reactors: ['a', 'b'], rolls: [20, 70], winners: 3 });
  assert.deepEqual(winnerIds(embed), ['b', 'a']);
  assert.match(embed.description, /^🏆 \*\*2 ganadores\*\*/);
  assert.match(embed.description, /3 ganadores de 2 participantes: ganan todos\./);
  assert.equal(content, '<@b> y <@a> han ganado el sorteo de <@creator-1>');
});

test('winners:20 con 20 participantes: ganan todos', async () => {
  const ids = users(20);
  const { embed } = await resolveWith({ reactors: ids, rolls: ids.map((_, i) => 100 - i), winners: 20 });
  assert.deepEqual(winnerIds(embed), ids);
  assert.match(embed.description, /^🏆 \*\*20 ganadores\*\*/);
  assert.doesNotMatch(embed.description, /ganan todos/, '20 de 20 no es "menos participantes que puestos"');
  assert.doesNotMatch(embed.description, /Desempate/);
});

test('ningún ganador repetido, forzado con tiradas iguales y empates que se repiten', async () => {
  // 5 a 50 por 3 puestos -> ronda 1: cuatro a 70 por 3 -> ronda 2: los cuatro
  // a 30 otra vez -> ronda 3: 5, 6, 7, 8.
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const { embed } = await resolveWith({ reactors: ids, rolls: [50, 50, 50, 50, 50, 70, 70, 70, 70, 10, 30, 30, 30, 30, 5, 6, 7, 8], winners: 3 });
  const winners = winnerIds(embed);
  assert.deepEqual(winners, ['d', 'c', 'b']);
  assert.equal(new Set(winners).size, 3);
  assert.match(embed.description, /Resuelto tras 3 rondas de tiradas entre ellos\./);
});

for (const winners of [0, 21]) {
  test(`winners:${winners} se rechaza con el rango en el mensaje y no publica nada`, async () => {
    const { error, sent, stored } = await announce({ integers: { winners } });
    assert.equal(error, 'Los ganadores deben ser un entero entre 1 y 20.');
    assert.equal(sent.length, 0);
    assert.equal(stored, null);
  });
}

// ============================================================
// EMPATES (tiradas inyectadas)
// ============================================================

test('98, 95, 95, 95 con winners:3: el 98 entra directo y de los tres 95 entran dos tras desempate, nombrando a los tres', async () => {
  const { embed } = await resolveWith({ reactors: ['a', 'b', 'c', 'd'], rolls: [98, 95, 95, 95, 60, 20, 80], winners: 3 });
  assert.deepEqual(winnerIds(embed), ['a', 'd', 'b']);
  assert.match(
    embed.description,
    /⚖️ Desempate entre <@b>, <@c> y <@d> por los 2 últimos puestos \(empate a \*\*95\*\*\)\. Resuelto con una nueva tirada entre ellos\./,
  );
});

test('98, 95, 95 con winners:3: entran los tres SIN desempate (el grupo cabe entero)', async () => {
  // withRolls falla si se pide una tirada más de las tres.
  const { embed } = await resolveWith({ reactors: ['a', 'b', 'c'], rolls: [98, 95, 95], winners: 3 });
  assert.deepEqual(winnerIds(embed), ['a', 'b', 'c']);
  assert.doesNotMatch(embed.description, /Desempate/);
});

test('50, 50, 50, 50 con winners:2: dos ganadores tras desempate', async () => {
  const { embed } = await resolveWith({ reactors: ['a', 'b', 'c', 'd'], rolls: [50, 50, 50, 50, 10, 90, 40, 70], winners: 2 });
  assert.deepEqual(winnerIds(embed), ['b', 'd']);
  assert.match(embed.description, /Desempate entre <@a>, <@b>, <@c> y <@d> por los 2 últimos puestos \(empate a \*\*50\*\*\)/);
});

test('un desempate que vuelve a empatar se resuelve en otra ronda', async () => {
  // a entra; b y c empatan a 60 por el último puesto, luego a 40, luego 7 a 3.
  const { embed } = await resolveWith({ reactors: ['a', 'b', 'c', 'd'], rolls: [50, 50, 50, 50, 80, 60, 60, 10, 40, 40, 7, 3], winners: 2 });
  assert.deepEqual(winnerIds(embed), ['a', 'b']);
  assert.match(embed.description, /Desempate entre <@a>, <@b>, <@c> y <@d> por los 2 últimos puestos/);
  assert.match(embed.description, /Resuelto tras 3 rondas de tiradas entre ellos\./);
});

test('un empate que se repite siempre: tras 10 rondas se elige al azar, sin bucle infinito', async () => {
  const sameEveryRound = Array.from({ length: 10 }, () => [33, 33]).flat();
  // [70, 50, 50]: b y c se disputan el último puesto; 10 rondas a 33-33 y la
  // elección final (randomInt(0, 2) -> 0: se intercambian).
  const { embed } = await resolveWith({ reactors: ['a', 'b', 'c'], rolls: [70, 50, 50, ...sameEveryRound, 0], winners: 2 });
  assert.deepEqual(winnerIds(embed), ['a', 'c']);
  assert.match(embed.description, /Tras 10 rondas de tiradas seguían empatados: elegido al azar entre ellos\./);
});

test('todos con la misma tirada y winners igual a los participantes: nadie fuera y sin desempate', async () => {
  const { embed } = await resolveWith({ reactors: ['a', 'b', 'c', 'd'], rolls: [50, 50, 50, 50], winners: 4 });
  assert.deepEqual(winnerIds(embed), ['a', 'b', 'c', 'd']);
  assert.doesNotMatch(embed.description, /Desempate/);
});

// ============================================================
// MENSAJE
// ============================================================

test('mensaje con @everyone y @here: se ve como texto y el payload no permite pingarlos', async () => {
  const { sent } = await announce({ strings: { message: '@everyone @here atentos' } });
  assert.equal(announcedMessage(sent[0]), '@everyone @here atentos', 'se ve como texto, en un embed (que nunca notifica)');
  assert.doesNotMatch(sent[0].content, /@everyone|@here/);
  assert.deepEqual(sent[0].allowedMentions, { parse: [], roles: [] });
});

test('mención de rol en el mensaje: no pinga; el rol configurado del sorteo sí', async () => {
  const { sent } = await announce({ guildId: GUILD_RAFFLE_ROLE, strings: { message: 'para <@&other-role> y <@999>' } });
  assert.match(sent[0].content, /^<@&raffle-role> /);
  assert.doesNotMatch(sent[0].content, /other-role|999/);
  assert.equal(announcedMessage(sent[0]), 'para <@&other-role> y <@999>');
  assert.deepEqual(sent[0].allowedMentions, { parse: [], roles: ['raffle-role'] });
});

test('el parámetro role sigue pingando junto a un mensaje', async () => {
  const { sent } = await announce({ role: { id: 'party-role' }, strings: { message: '<@&other-role>' } });
  assert.deepEqual(sent[0].allowedMentions, { parse: [], roles: ['party-role'] });
});

test('\\n se convierte en salto de línea real y cinco seguidos se quedan en dos', async () => {
  const { stored, sent } = await announce({ strings: { message: 'uno\\ndos\\n\\n\\n\\n\\ntres' } });
  assert.equal(stored.message, 'uno\ndos\n\ntres');
  assert.equal(announcedMessage(sent[0]), 'uno\ndos\n\ntres');
});

test('un ``` sin cerrar en el mensaje no se come "Reacciona…" ni el "solo miembros de @rol", y su recuadro se cierra', async () => {
  const { sent } = await announce({ role: { id: 'party-role' }, strings: { message: 'Premio: ```montura' } });
  assert.equal(
    sent[0].content,
    '<@&party-role> <@creator-1> ha comenzado un sorteo que terminará <t:1793730600:R>.\n\n' +
      'Reacciona con 🎉 para participar (solo miembros de <@&party-role>).',
  );
  assert.equal(announcedMessage(sent[0]), 'Premio: ```montura\n```');
});

test('300 caracteres se acepta; 301 se rechaza diciendo cuántos sobran', async () => {
  const ok = await announce({ strings: { message: 'x'.repeat(300) } });
  assert.equal(ok.sent.length, 1);
  assert.equal(ok.stored.message.length, 300);

  const tooLong = await announce({ strings: { message: 'x'.repeat(301) } });
  assert.equal(tooLong.error, 'El mensaje puede tener como mucho 300 caracteres: sobra 1.');
  assert.equal(tooLong.sent.length, 0);
});

test('el mensaje aparece en el anuncio y en el embed de resultados del mismo sorteo', async () => {
  const { channel, stored, sent } = await announce({ integers: { winners: 2 }, strings: { message: 'Premio: **T8**' } });
  assert.equal(announcedMessage(sent[0]), 'Premio: **T8**');

  const announcement = channel.store.get(stored.messageId);
  announcement.addReaction('🎉', [new FakeUser('a'), new FakeUser('b'), new FakeUser('c')]);
  await withRolls([10, 20, 30], () => resolveRaffle(makeClient({ channels: [channel] }), stored));
  const embed = channel.sent.at(-1).embeds[0].toJSON();
  assert.deepEqual(embed.fields[0], { name: 'Mensaje', value: 'Premio: **T8**' });
  assert.deepEqual(winnerIds(embed), ['c', 'b']);
});

test('con un solo ganador el mensaje también sale en el anuncio (texto de siempre + su embed) y en el resultado', async () => {
  const { channel, stored, sent } = await announce({ strings: { message: 'Solo uno' } });
  assert.equal(sent[0].content, '<@creator-1> ha comenzado un sorteo que terminará <t:1793730600:R>.\n\nReacciona con 🎉 para participar.');
  assert.equal(announcedMessage(sent[0]), 'Solo uno');

  channel.store.get(stored.messageId).addReaction('🎉', [new FakeUser('a'), new FakeUser('b')]);
  await withRolls([10, 20], () => resolveRaffle(makeClient({ channels: [channel] }), stored));
  const embed = channel.sent.at(-1).embeds[0].toJSON();
  assert.equal(embed.description, '🥇 **Ganador: <@b> con una tirada de 20!**');
  assert.deepEqual(embed.fields.map((f) => f.name), ['Mensaje', 'ROLLS']);
  assert.equal(embed.fields[0].value, 'Solo uno');
});

// ============================================================
// LÍMITES DEL EMBED
// ============================================================

test('20 ganadores y 40 participantes: field <= 1024, los 20 ganadores dentro y ninguna mención partida', async () => {
  const ids = users(40);
  const { embed } = await resolveWith({ reactors: ids, rolls: ids.map((_, i) => 100 - i), winners: 20 });
  const rolls = embed.fields.at(-1).value;
  assert.ok(rolls.length <= 1024, `${rolls.length} caracteres`);
  for (const id of ids.slice(0, 20)) assert.ok(rolls.includes(`<@${id}>`), `falta el ganador ${id}`);
  const lines = rolls.split('\n');
  const tail = lines.at(-1).match(/^… y (\d+) participantes más$/);
  assert.ok(tail, `última línea: ${lines.at(-1)}`);
  for (const line of lines.slice(0, -1)) assert.match(line, /^(🥇|🥈|🥉|\*\*\d+\.\*\*) <@\d{19}> — `\d+`$/);
  assert.equal(lines.length - 1 + Number(tail[1]), 40, 'los que salen más "y N más" son los 40');
});

test('mensaje de 300 caracteres con 20 ganadores (y el peor desempate): el embed no pasa de 6000', async () => {
  const ids = users(40);
  // 1 entra a 99; los otros 39 empatan a 50 por 19 puestos (desempate que nombra a 25 y "+14 más").
  const tiebreakRolls = ids.slice(1).map((_, i) => 100 - i);
  const { embed } = await resolveWith({ reactors: ids, rolls: [99, ...ids.slice(1).map(() => 50), ...tiebreakRolls], winners: 20, message: 'm'.repeat(300) });
  assert.equal(winnerIds(embed).length, 20);
  assert.ok(embedLength(embed) <= 6000, `${embedLength(embed)} caracteres`);
  assert.ok(embed.description.length <= 4096);
  assert.match(embed.description, /\+14 más/);

  const delayedWorst = buildRaffleResultsEmbed({
    lang: 'es',
    results: ids.map((id) => ({ user: { id }, roll: 50 })),
    winners: 20,
    message: 'm'.repeat(300),
    delayed: true,
    totalReactors: 500,
    tiebreak: { roll: 50, participants: ids.map((id) => ({ user: { id } })), slots: 20, rounds: 10, random: true },
  }).toJSON();
  assert.ok(embedLength(delayedWorst) <= 6000, `${embedLength(delayedWorst)} caracteres`);
});
