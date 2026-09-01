import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  getSheetIdOverride,
  getSheetTabOverride,
  getRangoInicioOverride,
  setSheetIdOverride,
  setSheetTabOverride,
  setRangoInicioOverride,
  __resetCacheForTests,
} from './ctaSheetConfig.js';

let dir;
let n = 0;

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cta-sheet-config-test-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function freshPath() {
  __resetCacheForTests(); // cada test usa su propio fichero: que no arrastre la caché del anterior
  return path.join(dir, `cfg-${n++}.json`);
}

test('sin fichero, los tres getters devuelven null', async () => {
  const filePath = freshPath();
  assert.equal(await getSheetIdOverride(filePath), null);
  assert.equal(await getSheetTabOverride(filePath), null);
  assert.equal(await getRangoInicioOverride(filePath), null);
});

test('setRangoInicioOverride() persiste y getRangoInicioOverride() lo devuelve, sin tocar sheetId/sheetTab', async () => {
  const filePath = freshPath();
  await setRangoInicioOverride(filePath, 'P3');

  assert.equal(await getRangoInicioOverride(filePath), 'P3');
  assert.equal(await getSheetIdOverride(filePath), null);
  assert.equal(await getSheetTabOverride(filePath), null);
});

test('los tres campos (sheetId/sheetTab/rangoInicio) conviven en el mismo fichero sin pisarse', async () => {
  const filePath = freshPath();
  await setSheetIdOverride(filePath, 'sheet-abc');
  await setSheetTabOverride(filePath, 'Hoja2026');
  await setRangoInicioOverride(filePath, 'P3');

  assert.equal(await getSheetIdOverride(filePath), 'sheet-abc');
  assert.equal(await getSheetTabOverride(filePath), 'Hoja2026');
  assert.equal(await getRangoInicioOverride(filePath), 'P3');

  await setRangoInicioOverride(filePath, 'B5');
  assert.equal(await getRangoInicioOverride(filePath), 'B5');
  assert.equal(await getSheetIdOverride(filePath), 'sheet-abc', 'cambiar rangoInicio no debe tocar sheetId');
  assert.equal(await getSheetTabOverride(filePath), 'Hoja2026', 'cambiar rangoInicio no debe tocar sheetTab');
});

test('setSheetIdOverride() persiste y getSheetIdOverride() lo devuelve, sin tocar sheetTab', async () => {
  const filePath = freshPath();
  await setSheetIdOverride(filePath, 'sheet-abc');

  assert.equal(await getSheetIdOverride(filePath), 'sheet-abc');
  assert.equal(await getSheetTabOverride(filePath), null);

  const onDisk = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(onDisk.sheetId, 'sheet-abc');
});

test('setSheetTabOverride() persiste y getSheetTabOverride() lo devuelve, sin tocar sheetId', async () => {
  const filePath = freshPath();
  await setSheetTabOverride(filePath, 'Hoja2026');

  assert.equal(await getSheetTabOverride(filePath), 'Hoja2026');
  assert.equal(await getSheetIdOverride(filePath), null);
});

test('setSheetIdOverride() y setSheetTabOverride() sobre el mismo fichero no se pisan entre sí', async () => {
  const filePath = freshPath();
  await setSheetIdOverride(filePath, 'sheet-abc');
  await setSheetTabOverride(filePath, 'Hoja2026');

  assert.equal(await getSheetIdOverride(filePath), 'sheet-abc');
  assert.equal(await getSheetTabOverride(filePath), 'Hoja2026');

  await setSheetIdOverride(filePath, 'sheet-nuevo');
  assert.equal(await getSheetIdOverride(filePath), 'sheet-nuevo');
  assert.equal(await getSheetTabOverride(filePath), 'Hoja2026', 'cambiar sheetId no debe tocar sheetTab');
});

test('sobrevive a un "reinicio" (releer desde disco con la caché limpia)', async () => {
  const filePath = freshPath();
  await setSheetIdOverride(filePath, 'sheet-persistente');
  await setSheetTabOverride(filePath, 'PestañaPersistente');

  __resetCacheForTests(); // simula un proceso nuevo: nada en memoria, solo lo que hay en disco

  assert.equal(await getSheetIdOverride(filePath), 'sheet-persistente');
  assert.equal(await getSheetTabOverride(filePath), 'PestañaPersistente');
});

test('dos escrituras concurrentes (mismo fichero) no se pierden entre sí', async () => {
  const filePath = freshPath();
  await Promise.all([setSheetIdOverride(filePath, 'sheet-concurrente'), setSheetTabOverride(filePath, 'PestañaConcurrente')]);

  assert.equal(await getSheetIdOverride(filePath), 'sheet-concurrente');
  assert.equal(await getSheetTabOverride(filePath), 'PestañaConcurrente');
});
