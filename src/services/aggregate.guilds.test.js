import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateBattle } from './aggregate.js';
import { normalizeConfig } from './config.js';

// Squads de gremio (isGuild): un gremio de Albion entero como bucket, en su
// propia sección y FUERA del total del gremio principal.

const MAIN_GUILD = 'FOAB';

function player(name, guildName, allianceName) {
  return { Name: name, GuildName: guildName, AllianceName: allianceName };
}

function summaryPlayer(name, guildName, allianceName) {
  return { name, guildName, allianceName, kills: 0, deaths: 0 };
}

function battle(players) {
  return { players: Object.fromEntries(players.map((p, index) => [`id-${index}`, p])) };
}

function kill(id, killer, victim) {
  return { EventId: id, Killer: killer, Victim: victim, Participants: [killer] };
}

function config(squads) {
  return normalizeConfig({ squads }, 'test');
}

const RAF = { raf: { isGuild: false, members: ['sziahogyvagy'] } };
const DEMENTIA = { Dementia: { isGuild: true, members: [] } };

// Batalla mixta: FOAB (principal), Dementia (seguido), Rival (enemigo).
// Dementia va en OTRA alianza a propósito: si no se excluyera de los
// enemigos, saldría contado como rival.
const szia = player('SziahogyVagy', 'FOAB', 'FRIEND');
const mainPlayer = player('MainPlayer', 'FOAB', 'FRIEND');
const demKiller = player('DemKiller', 'Dementia', 'ALLY');
const demHealer = player('DemHealer', 'Dementia', 'ALLY');
const rivalOne = player('RivalOne', 'Rival Guild', 'FOE');
const rivalTwo = player('RivalTwo', 'Rival Guild', 'FOE');

const presence = battle([
  summaryPlayer('SziahogyVagy', 'FOAB', 'FRIEND'),
  summaryPlayer('MainPlayer', 'FOAB', 'FRIEND'),
  summaryPlayer('DemHealer', 'Dementia', 'ALLY'), // 0 kills como killer, solo muere
  summaryPlayer('DemKiller', 'Dementia', 'ALLY'),
  summaryPlayer('DemIdle', 'Dementia', 'ALLY'), // presente, 0-0
  summaryPlayer('RivalOne', 'Rival Guild', 'FOE'),
  summaryPlayer('RivalTwo', 'Rival Guild', 'FOE'),
]);
const events = [
  kill(1, szia, rivalOne),
  kill(2, mainPlayer, rivalTwo),
  kill(3, demKiller, rivalOne),
  kill(4, demKiller, rivalTwo),
  kill(5, rivalOne, demHealer),
  kill(6, rivalTwo, mainPlayer),
];

function run(squads, extra = {}) {
  return aggregateBattle({ events, battles: [presence], config: config(squads), mainGuild: MAIN_GUILD, ...extra });
}

test('squad de gremio: recoge a todos los de ese gremio presentes en la batalla, también a los 0-0', () => {
  const result = run({ ...RAF, ...DEMENTIA });

  assert.equal(result.guildBuckets.length, 1);
  const dementia = result.guildBuckets[0];
  assert.equal(dementia.display, 'Dementia');
  assert.equal(dementia.isGuild, true);
  assert.deepEqual(dementia.players.map((p) => p.name).sort(), ['DemHealer', 'DemIdle', 'DemKiller']);
  assert.equal(dementia.kills, 2);
  assert.equal(dementia.deaths, 1);
  assert.ok(!result.buckets.some((b) => b.key === 'dementia'), 'el squad de gremio no va en la sección del gremio principal');
});

test('squad de gremio: el invariante del gremio principal sigue cuadrando y los seguidos no lo inflan', () => {
  const result = run({ ...RAF, ...DEMENTIA });

  const mainGuildKills = events.filter((e) => e.Killer.GuildName === MAIN_GUILD).length;
  const mainGuildDeaths = events.filter((e) => e.Victim.GuildName === MAIN_GUILD).length;
  const sumKills = result.buckets.reduce((acc, b) => acc + b.kills, 0);
  const sumDeaths = result.buckets.reduce((acc, b) => acc + b.deaths, 0);

  // kills(MAIN ZERG) + suma(squads de JUGADORES) == kills del gremio principal
  assert.equal(sumKills, mainGuildKills);
  assert.equal(result.totals.kills, mainGuildKills);
  assert.equal(sumDeaths, mainGuildDeaths);
  assert.equal(result.totals.deaths, mainGuildDeaths);

  // Y el mismo resultado que sin seguir a nadie: seguir un gremio no mueve
  // ni una kill del total principal.
  const withoutFollowed = run(RAF);
  assert.deepEqual(result.buckets, withoutFollowed.buckets.map((b) => ({ ...b })));
  assert.equal(result.totals.kills, withoutFollowed.totals.kills);

  assert.deepEqual(result.followedTotals, { kills: 2, deaths: 1, uniquePlayers: 3 });
  assert.deepEqual(result.combinedTotals, {
    kills: result.totals.kills + 2,
    deaths: result.totals.deaths + 1,
    uniquePlayers: result.totals.uniquePlayers + 3,
  });
});

test('squad de gremio: los jugadores únicos del principal y de los seguidos se cuentan por separado', () => {
  const result = run({ ...RAF, ...DEMENTIA });
  assert.equal(result.totals.uniquePlayers, 2, 'SziahogyVagy y MainPlayer, nadie de Dementia');
  assert.equal(result.followedTotals.uniquePlayers, 3);
});

test('squad de gremio: sus jugadores no cuentan como enemigos aunque estén en otra alianza', () => {
  assert.equal(run({ ...RAF, ...DEMENTIA }).totals.uniqueEnemies, 2, 'solo RivalOne y RivalTwo');
  // Sin seguir a Dementia, sus 3 jugadores (alianza ALLY) sí serían enemigos.
  assert.equal(run(RAF).totals.uniqueEnemies, 5);
});

test('un squad de jugadores vacío NO se comporta como gremio: cuenta cero y ya', () => {
  // Mismo nombre que el gremio de la batalla, pero isGuild: false y sin miembros.
  const result = run({ dementia: { isGuild: false, members: [] } });

  const bucket = result.buckets.find((b) => b.key === 'dementia');
  assert.deepEqual({ kills: bucket.kills, deaths: bucket.deaths, players: bucket.players }, { kills: 0, deaths: 0, players: [] });
  assert.equal(result.guildBuckets.length, 0);
  assert.equal(result.followedTotals.uniquePlayers, 0);
  assert.ok(
    !result.buckets.flatMap((b) => b.players).some((p) => p.name.startsWith('Dem')),
    'nadie de Dementia debe entrar en ningún bucket',
  );
});

test('jugador en un squad de jugadores Y en un gremio seguido: gana el squad de jugadores, con aviso', () => {
  const result = run({ ...RAF, ...DEMENTIA, heal: { isGuild: false, members: ['DemHealer'] } });

  const heal = result.buckets.find((b) => b.key === 'heal');
  assert.deepEqual(heal.players.map((p) => p.name), ['DemHealer']);
  assert.ok(!result.guildBuckets[0].players.some((p) => p.name === 'DemHealer'));
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /DemHealer/);
  assert.match(result.warnings[0], /HEAL/);
  assert.match(result.warnings[0], /Dementia/);
});

test('un squad de gremio que apunta al gremio principal se ignora con aviso (no duplica a nadie)', () => {
  const result = run({ ...RAF, ...DEMENTIA, foab: { isGuild: true, members: [] } });

  assert.deepEqual(result.guildBuckets.map((b) => b.key), ['dementia']);
  assert.ok(result.warnings.some((w) => /gremio principal/.test(w)));
  assert.equal(result.totals.uniquePlayers, 2);
});

test('nombres de gremio numéricos, con espacios o casing raro: igualdad exacta y casing original al mostrar', () => {
  const squads = {
    '123': { isGuild: true, members: [] },
    'Los Bombas': { isGuild: true, members: [] },
    dEmEnTiA: { isGuild: true, members: [] },
  };
  const odd = battle([
    summaryPlayer('Num', '123', 'X'),
    summaryPlayer('NumLargo', '1234', 'X'), // contiene "123": NO debe entrar
    summaryPlayer('Bomba', 'LOS BOMBAS', 'X'), // casing distinto: SÍ
    summaryPlayer('BombaDos', 'Los Bombas Dos', 'X'), // contiene "Los Bombas": NO
    summaryPlayer('Los', 'Los', 'X'), // contenido en "Los Bombas": NO
    summaryPlayer('Dem', 'Dementia', 'X'), // casing distinto: SÍ
  ]);
  const result = aggregateBattle({ events: [], battles: [odd], config: config(squads), mainGuild: MAIN_GUILD });

  const byDisplay = Object.fromEntries(result.guildBuckets.map((b) => [b.display, b.players.map((p) => p.name)]));
  assert.deepEqual(byDisplay, { '123': ['Num'], 'Los Bombas': ['Bomba'], dEmEnTiA: ['Dem'] });
});
