#!/usr/bin/env node
// Smoke test sin Discord: valida el pipeline real de agregación
// (API oficial -> config -> aggregate) contra una batalla real del gremio
// configurado en squads.json, y contra fixtures deterministas para los casos
// límite de nombres (numéricos, coincidencia parcial, casing).
//
// Uso: npm run smoke

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { getBattleEvents, SERVER_HOSTS } from '../src/services/albionApi.js';
import { loadConfig, invalidateConfigCache } from '../src/services/config.js';
import { aggregateBattle } from '../src/services/aggregate.js';

// El smoke test corre contra el fichero semilla del repo (referencia para
// pruebas/CI), no contra DATA_DIR: no simula un bot desplegado, valida el
// pipeline de agregación en sí.
const SQUADS_CONFIG_PATH = fileURLToPath(new URL('../src/config/squads.seed.json', import.meta.url));

let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✔ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function resolveGuildId(server, guildName) {
  const res = await fetch(`${SERVER_HOSTS[server]}/search?q=${encodeURIComponent(guildName)}`);
  if (!res.ok) throw new Error(`Búsqueda de gremio falló: ${res.status}`);
  const { guilds } = await res.json();
  return guilds.find((g) => g.Name.toLowerCase() === guildName.toLowerCase())?.Id ?? null;
}

async function findRecentBattleId(server, guildId) {
  const res = await fetch(`${SERVER_HOSTS[server]}/battles?guildId=${guildId}&limit=10&offset=0&sort=recent`);
  if (!res.ok) throw new Error(`Listado de batallas falló: ${res.status}`);
  const battles = await res.json();
  return battles.find((b) => b.totalKills > 0)?.id ?? battles[0]?.id ?? null;
}

/**
 * Punto 2: contra una batalla real, kills(MAIN ZERG) + suma(squads) debe
 * igualar los kills totales, y los porcentajes por bucket deben sumar 100% ±0.1.
 */
async function checkRealBattle() {
  console.log('\n[2] Batalla real: invariante de kills y porcentajes');

  const config = await loadConfig(SQUADS_CONFIG_PATH);
  const server = process.env.ALBION_SERVER || 'europe';
  const [firstGuildName] = [...config.guilds];

  const guildId = await resolveGuildId(server, firstGuildName);
  if (!guildId) {
    check(`resolver guildId de "${firstGuildName}" en ${server}`, false, 'no encontrado en gameinfo search');
    return;
  }

  const battleId = await findRecentBattleId(server, guildId);
  if (!battleId) {
    check('encontrar una batalla reciente', false, `sin batallas recientes para guildId ${guildId}`);
    return;
  }

  console.log(`  (batalla real ${battleId}, servidor ${server}, gremio "${firstGuildName}")`);
  const events = await getBattleEvents(server, battleId);
  check('la batalla tiene eventos', events.length > 0, `0 eventos para ${battleId}`);
  if (events.length === 0) return;

  const result = aggregateBattle({ events, config });
  const sumKills = result.buckets.reduce((acc, b) => acc + b.kills, 0);
  const sumDeaths = result.buckets.reduce((acc, b) => acc + b.deaths, 0);

  check(
    'kills(MAIN ZERG) + suma(squads) == kills totales',
    sumKills === result.totals.kills,
    `${sumKills} != ${result.totals.kills}`,
  );
  check(
    'deaths(MAIN ZERG) + suma(squads) == deaths totales',
    sumDeaths === result.totals.deaths,
    `${sumDeaths} != ${result.totals.deaths}`,
  );

  if (result.totals.kills > 0) {
    const percentSum = result.buckets.reduce((acc, b) => acc + (b.kills / result.totals.kills) * 100, 0);
    check('los porcentajes por bucket suman 100% ±0.1', Math.abs(percentSum - 100) <= 0.1, `sumaron ${percentSum.toFixed(2)}%`);
  } else {
    console.log('  (el gremio no tuvo kills en esta batalla; se omite el chequeo de porcentajes)');
  }
}

async function withTempConfig(content, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'foab-smoke-'));
  const file = path.join(dir, 'squads.json');
  await writeFile(file, JSON.stringify(content));
  try {
    return await fn(file);
  } finally {
    invalidateConfigCache();
    await rm(dir, { recursive: true, force: true });
  }
}

function makeKillEvent(id, killerName, killerGuild, victimName, victimGuild) {
  return {
    EventId: id,
    Killer: { Name: killerName, GuildName: killerGuild, AllianceName: 'FRIEND' },
    Victim: { Name: victimName, GuildName: victimGuild, AllianceName: 'FOE' },
    Participants: [{ Name: killerName, GuildName: killerGuild, AllianceName: 'FRIEND' }],
  };
}

/**
 * Punto 3: "123" y "1114" se cuentan en su squad; nombres que solo CONTIENEN
 * "123" como substring ("1234", "0123", "x123x") no deben colarse en ese
 * squad por una comparación con includes() en vez de igualdad exacta.
 */
async function checkNumericAndPartialNames() {
  console.log('\n[3] Nombres numéricos ("123"/"1114") sin coincidencia parcial');

  await withTempConfig({ guilds: ['testguild'], squads: { raf: ['123', '1114'] } }, async (file) => {
    const config = await loadConfig(file);
    const events = [
      makeKillEvent(1, '123', 'TestGuild', 'Enemy1', 'Enemy'),
      makeKillEvent(2, '1114', 'TestGuild', 'Enemy2', 'Enemy'),
      // Estos NO son "123"/"1114": si el matching usara includes() se
      // colarían igualmente en "raf".
      makeKillEvent(3, '1234', 'TestGuild', 'Enemy3', 'Enemy'),
      makeKillEvent(4, '0123', 'TestGuild', 'Enemy4', 'Enemy'),
      makeKillEvent(5, 'x123x', 'TestGuild', 'Enemy5', 'Enemy'),
      makeKillEvent(6, '11140', 'TestGuild', 'Enemy6', 'Enemy'),
    ];

    const result = aggregateBattle({ events, config });
    const byKey = Object.fromEntries(result.buckets.map((b) => [b.key, b]));
    const rafNames = byKey.raf.players.map((p) => p.name).sort();
    const mainNames = byKey.main.players.map((p) => p.name).sort();

    check('"123" y "1114" caen en el squad "raf"', rafNames.join(',') === '1114,123', `raf tiene: ${rafNames.join(', ')}`);
    check(
      '"1234", "0123", "x123x", "11140" NO se cuelan en "raf" (caen en MAIN ZERG)',
      ['1234', '0123', 'x123x', '11140'].every((n) => mainNames.includes(n)) && !rafNames.some((n) => n !== '123' && n !== '1114'),
      `main tiene: ${mainNames.join(', ')}; raf tiene: ${rafNames.join(', ')}`,
    );
  });
}

/**
 * Punto 4: un jugador declarado en squads.json con un casing distinto al que
 * devuelve la API del juego debe seguir contando en su squad, y mostrarse con
 * el casing de la API (no el del JSON).
 */
async function checkCasingMismatch() {
  console.log('\n[4] Casing distinto entre squads.json y la API del juego');

  await withTempConfig({ guilds: ['testguild'], squads: { raf: ['winterblatt'] } }, async (file) => {
    const config = await loadConfig(file);
    const events = [makeKillEvent(1, 'Winterblatt', 'TestGuild', 'Enemy1', 'Enemy')];

    const result = aggregateBattle({ events, config });
    const rafBucket = result.buckets.find((b) => b.key === 'raf');

    check('cuenta el kill en "raf" pese al casing distinto', rafBucket.kills === 1, `raf.kills = ${rafBucket.kills}`);
    check(
      'el nombre mostrado es el de la API ("Winterblatt"), no el del JSON ("winterblatt")',
      rafBucket.players[0]?.name === 'Winterblatt',
      `mostrado: "${rafBucket.players[0]?.name}"`,
    );
  });
}

async function main() {
  console.log('FOAB Bot — smoke test (sin Discord)');

  for (const step of [checkRealBattle, checkNumericAndPartialNames, checkCasingMismatch]) {
    try {
      await step();
    } catch (error) {
      failures += 1;
      console.error(`  ✖ excepción en ${step.name}:`, error.message);
    }
  }

  console.log(failures === 0 ? '\n✔ TODO OK' : `\n✖ ${failures} chequeo(s) fallaron`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
