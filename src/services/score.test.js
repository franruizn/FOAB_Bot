import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSquadScore, ScoreError } from './score.js';

// Config de prueba: squad "raf" con 6 miembros en squads.json pero solo 3
// presentes en la batalla, squad "clean" con 3 miembros pero solo 2
// presentes (y ninguna death, para el caso deaths=0), squad "empty" con 1
// miembro que nunca aparece en la batalla.
function makeConfig() {
  return {
    guilds: new Set(['foab']),
    squadOrder: ['raf', 'clean', 'empty'],
    squads: new Map([
      [
        'raf',
        {
          display: 'RAF',
          members: new Set(['sziahogyvagy', '123', '1114', 'ghost1', 'ghost2', 'ghost3']),
        },
      ],
      ['clean', { display: 'CLEAN', members: new Set(['nodeathguy', 'othercleanmate', 'ghostclean']) }],
      ['empty', { display: 'EMPTY', members: new Set(['nadieaqui']) }],
    ]),
    playerToSquad: new Map([
      ['sziahogyvagy', 'raf'],
      ['123', 'raf'],
      ['1114', 'raf'],
      ['nodeathguy', 'clean'],
      ['othercleanmate', 'clean'],
    ]),
    warnings: [],
  };
}

function player(name, guildName, allianceName) {
  return { Name: name, GuildName: guildName, AllianceName: allianceName };
}

// Batalla (ya fusionada, como hace /getkills con varias battleIds):
//
// raf:
//  1) SziahogyVagy mata a EnemyOne, participa "123" (assist)
//  2) EnemyTwo mata a SziahogyVagy (death)
//  3) "123" mata a EnemyThree
//  4) "1114" mata a EnemyFour, participa SziahogyVagy (assist)
//  -> ghost1/ghost2/ghost3 nunca aparecen.
//
// clean (sin deaths):
//  5) nodeathguy mata a EnemyFive
//  6) othercleanmate mata a EnemySix, participa nodeathguy (assist)
//  -> ghostclean nunca aparece.
//
// main (sin squad):
//  7) mainguy mata a EnemySeven
//
// empty: nadieaqui nunca aparece en ningún evento.
const events = [
  {
    EventId: 1,
    Killer: player('SziahogyVagy', 'FOAB', 'FRIEND'),
    Victim: player('EnemyOne', 'Rival Guild', 'FOE'),
    Participants: [player('SziahogyVagy', 'FOAB', 'FRIEND'), player('123', 'FOAB', 'FRIEND')],
  },
  {
    EventId: 2,
    Killer: player('EnemyTwo', 'Rival Guild', 'FOE'),
    Victim: player('SziahogyVagy', 'FOAB', 'FRIEND'),
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
    Killer: player('1114', 'FOAB', 'FRIEND'),
    Victim: player('EnemyFour', 'Rival Guild', 'FOE'),
    Participants: [player('1114', 'FOAB', 'FRIEND'), player('SziahogyVagy', 'FOAB', 'FRIEND')],
  },
  {
    EventId: 5,
    Killer: player('nodeathguy', 'FOAB', 'FRIEND'),
    Victim: player('EnemyFive', 'Rival Guild', 'FOE'),
    Participants: [player('nodeathguy', 'FOAB', 'FRIEND')],
  },
  {
    EventId: 6,
    Killer: player('othercleanmate', 'FOAB', 'FRIEND'),
    Victim: player('EnemySix', 'Rival Guild', 'FOE'),
    Participants: [player('othercleanmate', 'FOAB', 'FRIEND'), player('nodeathguy', 'FOAB', 'FRIEND')],
  },
  {
    EventId: 7,
    Killer: player('mainguy', 'FOAB', 'FRIEND'),
    Victim: player('EnemySeven', 'Rival Guild', 'FOE'),
    Participants: [player('mainguy', 'FOAB', 'FRIEND')],
  },
];

test('kills, deaths y medias de un squad contra valores conocidos a mano', () => {
  const config = makeConfig();
  const score = computeSquadScore({ events, config, squadKey: 'raf' });

  // kills reales: SziahogyVagy(1) + "123"(1) + "1114"(1) = 3
  // deaths: SziahogyVagy(1) = 1
  // assists: SziahogyVagy asiste en el evento 4 (+1), "123" asiste en el
  // evento 1 (+1), "1114" no asiste en ningún kill ajeno (+0) = 2
  assert.deepEqual(score, {
    empty: false,
    squadKey: 'raf',
    squadDisplay: 'RAF',
    kills: 3,
    deaths: 1,
    assists: 2,
    jugadores: 3,
    killsPorJugador: 1,
    deathsPorJugador: 0.3, // 1/3 redondeado a 1 decimal
    kda: 5, // (3 + 2) / 1
  });
});

test('las medias usan los jugadores presentes, no el total de squads.json', () => {
  const config = makeConfig();
  assert.equal(config.squads.get('raf').members.size, 6); // 6 en el fichero

  const score = computeSquadScore({ events, config, squadKey: 'raf' });
  assert.equal(score.jugadores, 3); // solo los 3 que aparecieron en la batalla
  assert.equal(score.killsPorJugador, 3 / 3);
});

test('deaths=0 -> KDA = kills + assists, sin división ni Infinity ni NaN', () => {
  const config = makeConfig();
  const score = computeSquadScore({ events, config, squadKey: 'clean' });

  // kills reales: nodeathguy(1) + othercleanmate(1) = 2
  // deaths: 0
  // assists: nodeathguy asiste en el evento 6 (+1) = 1
  assert.deepEqual(score, {
    empty: false,
    squadKey: 'clean',
    squadDisplay: 'CLEAN',
    kills: 2,
    deaths: 0,
    assists: 1,
    jugadores: 2,
    killsPorJugador: 1,
    deathsPorJugador: 0,
    kda: 3, // kills + assists, no (kills+assists)/0
  });

  assert.equal(Number.isFinite(score.kda), true);
  assert.equal(Number.isNaN(score.kda), false);
});

test('jugadores=0 -> resultado vacío distinguible de un 0-0 real', () => {
  const config = makeConfig();
  const score = computeSquadScore({ events, config, squadKey: 'empty' });

  assert.deepEqual(score, { empty: true, squadKey: 'empty', squadDisplay: 'EMPTY' });
  // Distinto de un 0-0 real: un resultado no vacío siempre trae kills/deaths/etc.
  assert.equal('kills' in score, false);
  assert.equal('jugadores' in score, false);
});

test('un squad cuyos miembros no estuvieron en la batalla da jugadores=0', () => {
  const config = makeConfig();
  // "empty" solo tiene a "nadieaqui" en squads.json, que no aparece en
  // ningún evento de la batalla.
  const score = computeSquadScore({ events, config, squadKey: 'empty' });
  assert.equal(score.empty, true);
});

test('acepta MAIN ZERG con el mismo significado de bucket que /getkills', () => {
  const config = makeConfig();
  const score = computeSquadScore({ events, config, squadKey: 'MAIN ZERG' });

  assert.deepEqual(score, {
    empty: false,
    squadKey: 'main',
    squadDisplay: 'MAIN ZERG',
    kills: 1,
    deaths: 0,
    assists: 0,
    jugadores: 1,
    killsPorJugador: 1,
    deathsPorJugador: 0,
    kda: 1,
  });
});

test('la comparación de squadKey es case-insensitive por igualdad exacta', () => {
  const config = makeConfig();
  const lower = computeSquadScore({ events, config, squadKey: 'raf' });
  const upper = computeSquadScore({ events, config, squadKey: 'RAF' });
  const mixed = computeSquadScore({ events, config, squadKey: 'RaF' });
  const main = computeSquadScore({ events, config, squadKey: 'main' });

  assert.deepEqual(lower, upper);
  assert.deepEqual(lower, mixed);
  assert.equal(main.squadKey, 'main');
});

test('lanza ScoreError si el squadKey no existe', () => {
  const config = makeConfig();
  assert.throws(() => computeSquadScore({ events, config, squadKey: 'no-existe' }), ScoreError);
});
