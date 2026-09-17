import { aggregateBattle } from './aggregate.js';

export class ScoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScoreError';
  }
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function findBucket(buckets, squadKeyInput) {
  const target = String(squadKeyInput).trim().toLowerCase();
  return buckets.find((bucket) => bucket.key === target || bucket.display.toLowerCase() === target) ?? null;
}

/**
 * Calcula el score (kills, deaths, assists, KDA...) de un squad -o MAIN
 * ZERG- para una batalla, o para varias ya fusionadas en un único array de
 * eventos (igual que hace /getkills: concatena los eventos de cada batalla
 * antes de agregar).
 *
 * Reutiliza aggregateBattle() dos veces en vez de duplicar su lógica de
 * buckets: una vez con countAssists=false (kills reales, solo el Killer) y
 * otra con countAssists=true (kills acreditadas a todo Participant,
 * incluido el propio Killer). La diferencia entre ambas, por bucket, son
 * las assists; y el bucket "credited" es superset del "real" en jugadores,
 * porque incluye a quien solo asistió sin matar ni morir -> ese superset es
 * la definición de "jugadores presentes en la batalla".
 *
 * @param {object} params
 * @param {object[]} params.events - eventos de una o varias batallas, ya
 *   fusionados en un solo array (mismo formato que getBattleEvents).
 * @param {import('./config.js').ConfigData} params.config
 * @param {string} params.squadKey - clave de squad de squads.json, o
 *   "main"/"MAIN ZERG" para el zerg principal. Comparación case-insensitive
 *   por igualdad exacta (nunca includes()).
 * @returns {
 *   | { empty: true, squadKey: string, squadDisplay: string }
 *   | {
 *       empty: false,
 *       squadKey: string,
 *       squadDisplay: string,
 *       kills: number,
 *       deaths: number,
 *       assists: number,
 *       jugadores: number,
 *       killsPorJugador: number,
 *       deathsPorJugador: number,
 *       kda: number,
 *     }
 * }
 * @throws {ScoreError} si squadKey no coincide con ningún squad ni con MAIN ZERG
 */
export function computeSquadScore({ events, config, squadKey }) {
  const realResult = aggregateBattle({ events, config, countAssists: false });
  const creditedResult = aggregateBattle({ events, config, countAssists: true });

  const realBucket = findBucket(realResult.buckets, squadKey);
  const creditedBucket = findBucket(creditedResult.buckets, squadKey);

  if (!realBucket || !creditedBucket) {
    throw new ScoreError(`No existe ningún squad ni MAIN ZERG que coincida con "${squadKey}".`);
  }

  const resolvedKey = realBucket.key;
  const squadDisplay = realBucket.display;

  // jugadores presentes = los del bucket "credited", que incluye también a
  // quien solo asistió (sin kill real ni death propia). Deliberadamente NO
  // se usa config.squads.get(key).members.size: eso es el roster completo
  // del fichero, no quién estuvo realmente en la batalla.
  const jugadores = creditedBucket.players.length;

  if (jugadores === 0) {
    return { empty: true, squadKey: resolvedKey, squadDisplay };
  }

  const kills = realBucket.kills;
  const deaths = realBucket.deaths;
  const assists = creditedBucket.kills - realBucket.kills;

  const killsPorJugador = round(kills / jugadores, 1);
  const deathsPorJugador = round(deaths / jugadores, 1);
  // deaths=0: el mismo resultado que dividir entre 1, sin división real.
  const kda = deaths === 0 ? round(kills + assists, 2) : round((kills + assists) / deaths, 2);

  return {
    empty: false,
    squadKey: resolvedKey,
    squadDisplay,
    kills,
    deaths,
    assists,
    jugadores,
    killsPorJugador,
    deathsPorJugador,
    kda,
  };
}
