import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// /raffle sin las opciones nuevas tiene que publicar EXACTAMENTE lo mismo que
// antes de que existieran. __fixtures__/raffle-golden.json es la salida del
// código anterior (commit 6c5efae) con los mismos escenarios, tiradas y reloj
// fijos (__fixtures__/raffleHarness.js). Excepción: result.topTieTwice y
// result.topTieRandom se añadieron al corregir el texto del desempate de un
// ganador (antes decía "segunda tirada" aunque no lo fuera). Si un cambio de texto es a propósito,
// se regenera con `node scripts/raffle-golden.mjs`; si no, este test avisa.

const DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'raffle-golden-test-'));
process.env.DATA_DIR = DATA_DIR;

const { setConfig } = await import('./services/guildStore.js');
const { execute } = await import('./commands/sorteo.js');
const { resolveRaffle } = await import('./raffleScheduler.js');
const { runGoldenScenarios, setupGoldenGuilds } = await import('./__fixtures__/raffleHarness.js');

const golden = JSON.parse(await readFile(new URL('./__fixtures__/raffle-golden.json', import.meta.url), 'utf8'));

before(() => setupGoldenGuilds(setConfig));
after(() => rm(DATA_DIR, { recursive: true, force: true }));

// Única diferencia buscada: el anuncio lleva ahora parse: [] para que el
// mensaje del sorteo no pueda pingar. Con allowed_mentions presente, Discord
// ya no parseaba nada sin "parse", así que el efecto es el mismo; el resto
// del payload tiene que coincidir byte a byte.
function withParseEmpty(expected) {
  const copy = structuredClone(expected);
  for (const [name, scenario] of Object.entries(copy)) {
    if (!name.startsWith('announce.')) continue;
    for (const sent of scenario.sent) sent.allowedMentions = { parse: [], ...sent.allowedMentions };
  }
  return copy;
}

function assertSameAsGolden(actual) {
  const expected = withParseEmpty(golden);
  assert.deepEqual(Object.keys(actual), Object.keys(expected));
  for (const name of Object.keys(expected)) assert.deepEqual(actual[name], expected[name], `escenario ${name}`);
}

test('golden: /raffle sin winners ni message publica lo mismo que antes (anuncio y resultado)', async () => {
  assertSameAsGolden(await runGoldenScenarios({ execute, resolveRaffle }));
});

test('golden: winners:1 explícito (y message vacío guardado) es idéntico a no pasar la opción', async () => {
  assertSameAsGolden(
    await runGoldenScenarios({ execute, resolveRaffle }, { integers: { winners: 1 }, raffleExtra: { winners: 1, message: null } }),
  );
});

test('golden: el anuncio sigue sin notificar al creador y solo al rol del sorteo', () => {
  assert.deepEqual(golden['announce.plain'].sent[0].allowedMentions, { roles: [] });
  assert.deepEqual(golden['announce.restricted'].sent[0].allowedMentions, { roles: ['party-role'] });
});
