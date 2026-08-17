import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateBattle } from './aggregate.js';

// Config de prueba equivalente a lo que devuelve config.loadConfig():
// gremio "FOAB", squad "raf" con un solo miembro, squad "empty" sin nadie en
// ningún evento (cubre "squad sin nadie presente").
function makeConfig(warnings = []) {
  return {
    guilds: new Set(['foab']),
    squadOrder: ['raf', 'empty'],
    squads: new Map([
      ['raf', { display: 'RAF', members: new Set(['sziahogyvagy']) }],
      ['empty', { display: 'EMPTY', members: new Set(['nadie']) }],
    ]),
    playerToSquad: new Map([['sziahogyvagy', 'raf']]),
    warnings,
  };
}

function player(name, guildName, allianceName) {
  return { Name: name, GuildName: guildName, AllianceName: allianceName };
}

// 6 eventos: (1) kill de gremio + jugador de squad, (2) muerte de gremio +
// jugador del gremio sin squad, (3) kill de gremio con nombre numérico,
// (4) muerte de gremio con nombre numérico, (5) otro kill de gremio (mismo
// jugador sin squad del evento 2, para probar acumulación), (6) evento
// enemigo-vs-enemigo que no debe tocar ningún bucket.
const events = [
  {
    EventId: 1,
    // Casing distinto al de squads.json ("sziahogyvagy") a propósito: el
    // matching de squad debe ser case-insensitive.
    Killer: player('SziahogyVagy', 'FOAB', 'FRIEND'),
    Victim: player('EnemyOne', 'Rival Guild', 'FOE'),
    Participants: [player('SziahogyVagy', 'FOAB', 'FRIEND')],
  },
  {
    EventId: 2,
    Killer: player('EnemyTwo', 'Rival Guild', 'FOE'),
    Victim: player('MainPlayer', 'FOAB', 'FRIEND'),
    Participants: [player('EnemyTwo', 'Rival Guild', 'FOE')],
  },
  {
    EventId: 3,
    Killer: player('123', 'FOAB', 'FRIEND'),
    Victim: player('EnemyThree', 'Rival Guild', 'FOE'),
    Participants: [player('123', 'FOAB', 'FRIEND')],
  },
  {
    EventId: 4,
    Killer: player('EnemyFour', 'Rival Guild', 'FOE'),
    Victim: player('1114', 'FOAB', 'SOLO'),
    Participants: [player('EnemyFour', 'Rival Guild', 'FOE')],
  },
  {
    EventId: 5,
    Killer: player('MainPlayer', 'FOAB', 'FRIEND'),
    Victim: player('EnemyFive', 'Rival Guild', 'FOE'),
    Participants: [player('MainPlayer', 'FOAB', 'FRIEND')],
  },
  {
    EventId: 6,
    Killer: player('EnemySix', 'Rival Guild', 'FOE'),
    Victim: player('EnemySeven', 'Rival Guild', 'FOE'),
    Participants: [player('EnemySix', 'Rival Guild', 'FOE')],
  },
];

test('agrega kills/deaths por bucket y cuadran los totales', () => {
  const result = aggregateBattle({ events, config: makeConfig() });

  const byKey = Object.fromEntries(result.buckets.map((bucket) => [bucket.key, bucket]));

  // jugador de squad
  assert.equal(byKey.raf.kills, 1);
  assert.equal(byKey.raf.deaths, 0);
  assert.deepEqual(byKey.raf.players, [{ name: 'SziahogyVagy', kills: 1, deaths: 0 }]);

  // squad sin nadie presente
  assert.equal(byKey.empty.kills, 0);
  assert.equal(byKey.empty.deaths, 0);
  assert.deepEqual(byKey.empty.players, []);

  // jugador del gremio sin squad + nombres numéricos, todos en MAIN ZERG
  assert.equal(byKey.main.display, 'MAIN ZERG');
  assert.equal(byKey.main.kills, 2); // MainPlayer(1) + "123"(1) + "1114"(0)
  assert.equal(byKey.main.deaths, 2); // MainPlayer(1) + "123"(0) + "1114"(1)

  const mainByName = Object.fromEntries(byKey.main.players.map((p) => [p.name, p]));
  assert.deepEqual(mainByName.MainPlayer, { name: 'MainPlayer', kills: 1, deaths: 1 });
  assert.deepEqual(mainByName['123'], { name: '123', kills: 1, deaths: 0 });
  assert.deepEqual(mainByName['1114'], { name: '1114', kills: 0, deaths: 1 });

  // orden de buckets: MAIN ZERG primero, luego squadOrder
  assert.deepEqual(result.buckets.map((b) => b.key), ['main', 'raf', 'empty']);

  // el invariante: kills(MAIN ZERG) + suma(kills de squads) = kills totales
  const sumBucketKills = result.buckets.reduce((acc, b) => acc + b.kills, 0);
  const sumBucketDeaths = result.buckets.reduce((acc, b) => acc + b.deaths, 0);
  assert.equal(sumBucketKills, result.totals.kills);
  assert.equal(sumBucketDeaths, result.totals.deaths);
  assert.equal(result.totals.kills, 3);
  assert.equal(result.totals.deaths, 2);
});

test('detecta la alianza amiga por mayoría (no hardcodeada)', () => {
  const result = aggregateBattle({ events, config: makeConfig() });
  // FRIEND aparece en 3 jugadores del gremio (SziahogyVagy, MainPlayer, "123"),
  // SOLO solo en 1 ("1114") -> gana FRIEND.
  assert.equal(result.alliance, 'FRIEND');
});

test('uniqueEnemies cuenta por alianza, no por gremio', () => {
  const result = aggregateBattle({ events, config: makeConfig() });
  // 7 enemigos distintos (EnemyOne..EnemySeven, alianza FOE) + "1114" (gremio
  // FOAB pero alianza SOLO, distinta de la amiga) = 8.
  assert.equal(result.totals.uniqueEnemies, 8);
});

test('uniquePlayers cuenta solo jugadores de gremio con kill o death acreditado', () => {
  const result = aggregateBattle({ events, config: makeConfig() });
  assert.equal(result.totals.uniquePlayers, 4); // SziahogyVagy, MainPlayer, "123", "1114"
});

test('propaga los warnings de config (jugador en varios squads)', () => {
  const warning = 'El jugador "duplicado" está en varios squads: "raf" y "empty"';
  const result = aggregateBattle({ events, config: makeConfig([warning]) });
  assert.deepEqual(result.warnings, [warning]);
});

test('countAssists=true acredita el kill a cada participant, no solo al Killer', () => {
  const assistEvents = [
    {
      EventId: 100,
      Killer: player('SziahogyVagy', 'FOAB', 'FRIEND'),
      Victim: player('EnemyOne', 'Rival Guild', 'FOE'),
      Participants: [
        player('SziahogyVagy', 'FOAB', 'FRIEND'),
        player('MainPlayer', 'FOAB', 'FRIEND'),
        player('EnemyOne', 'Rival Guild', 'FOE'), // participante que no es de nuestro gremio
      ],
    },
  ];

  const result = aggregateBattle({ events: assistEvents, config: makeConfig(), countAssists: true });
  const byKey = Object.fromEntries(result.buckets.map((bucket) => [bucket.key, bucket]));

  assert.equal(byKey.raf.kills, 1); // SziahogyVagy
  assert.equal(byKey.main.kills, 1); // MainPlayer
  assert.equal(result.totals.kills, 2);
});
