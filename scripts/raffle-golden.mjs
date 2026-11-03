#!/usr/bin/env node
// Regenera src/__fixtures__/raffle-golden.json: la salida de /raffle SIN las
// opciones winners/message, con tiradas y reloj fijos. src/raffle.golden.test.js
// exige que el código siga publicando exactamente esto.
//
// Solo se regenera cuando un cambio de texto es intencionado. Por defecto
// ejecuta el código de este repo; con una ruta, el de otra copia (un worktree
// de un commit anterior, por ejemplo):
//
//   node scripts/raffle-golden.mjs [raíz del código a ejecutar]
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const codeRoot = path.resolve(process.argv[2] ?? repoRoot);
const outPath = path.join(repoRoot, 'src', '__fixtures__', 'raffle-golden.json');

process.env.DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'raffle-golden-'));

const from = (root, rel) => import(pathToFileURL(path.join(root, rel)).href);
const harness = await from(repoRoot, 'src/__fixtures__/raffleHarness.js');
const { setConfig } = await from(codeRoot, 'src/services/guildStore.js');
const { execute } = await from(codeRoot, 'src/commands/sorteo.js');
const { resolveRaffle } = await from(codeRoot, 'src/raffleScheduler.js');

await harness.setupGoldenGuilds(setConfig);
const out = await harness.runGoldenScenarios({ execute, resolveRaffle });
// El código nuevo añade parse: [] al anuncio; el golden guarda la forma
// anterior y el test la compara añadiéndolo. Se quita aquí para que
// regenerar desde el código actual no cambie el fichero.
for (const [name, scenario] of Object.entries(out)) {
  if (!name.startsWith('announce.')) continue;
  for (const sent of scenario.sent) {
    if (sent.allowedMentions && Array.isArray(sent.allowedMentions.parse) && sent.allowedMentions.parse.length === 0) delete sent.allowedMentions.parse;
  }
}
await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`);
console.log(`golden: ${Object.keys(out).length} escenarios -> ${path.relative(repoRoot, outPath)}`);
// execute() deja el setTimeout del sorteo (simulado, pero el proceso no sale solo).
process.exit(0);
