import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { guardarComp, borrarComp, listarComps, getComp, CtaCompError } from './ctaComp.js';

const DIR = await mkdtemp(path.join(os.tmpdir(), 'ctacomp-test-'));
let fileCounter = 0;
function tempFile() {
  return path.join(DIR, `comps-${fileCounter++}.json`);
}

after(async () => {
  await rm(DIR, { recursive: true, force: true });
});

function compValida(overrides = {}) {
  return {
    nombre: 'ZvZ Standard',
    creadoPor: 'discord-officer-1',
    categorias: {
      caller: { nombre: 'Caller', emoji: '🟣', orden: 1 },
      tanque: { nombre: 'Tanque', emoji: '🔵', orden: 2 },
      soporte: { nombre: 'Soporte', emoji: '🟢', orden: 3 },
    },
    roles: {
      'maza-pesada': { nombre: 'Maza Pesada', emoji: '<:maza:123456789012345678>', categoria: 'tanque', nota: '' },
      santi: { nombre: 'Santi', emoji: '🧪', categoria: 'soporte', nota: '' },
      hoj: { nombre: 'HOJ', emoji: '⚖️', categoria: 'caller', nota: '' },
      perma: { nombre: 'Perma', emoji: '🛡️' }, // sin categoría a propósito
    },
    parties: [{ nombre: 'Party 1', slots: ['maza-pesada', 'santi', 'perma', 'hoj', 'hoj'] }],
    ...overrides,
  };
}

test('guardarComp + getComp: guarda y devuelve exactamente lo validado, rol sin categoría -> null', async () => {
  const file = tempFile();
  const { key, comp } = await guardarComp(file, 'zvz-standard', compValida());

  assert.equal(key, 'zvz-standard');
  assert.equal(comp.roles.perma.categoria, null);
  assert.equal(comp.roles.perma.nota, '');

  const leido = await getComp(file, 'ZVZ-Standard'); // case-insensitive
  assert.deepEqual(leido, comp);
});

test('getComp con clave inexistente devuelve null, no lanza', async () => {
  const file = tempFile();
  await guardarComp(file, 'zvz-standard', compValida());
  assert.equal(await getComp(file, 'no-existe'), null);
});

test('listarComps refleja nombre, numRoles, numCategorias y numParties', async () => {
  const file = tempFile();
  await guardarComp(file, 'zvz-standard', compValida());
  await guardarComp(file, 'aoe', compValida({ nombre: 'AoE Roam' }));

  const lista = await listarComps(file);
  const nombres = lista.map((c) => c.nombre);
  assert.deepEqual(nombres, ['AoE Roam', 'ZvZ Standard']); // orden alfabético

  const zvz = lista.find((c) => c.key === 'zvz-standard');
  assert.equal(zvz.numRoles, 4);
  assert.equal(zvz.numCategorias, 3);
  assert.equal(zvz.numParties, 1);
});

test('borrarComp elimina la plantilla; sobre una clave inexistente lanza CtaCompError', async () => {
  const file = tempFile();
  await guardarComp(file, 'zvz-standard', compValida());

  const { comp } = await borrarComp(file, 'zvz-standard');
  assert.equal(comp.nombre, 'ZvZ Standard');
  assert.equal(await getComp(file, 'zvz-standard'), null);

  await assert.rejects(() => borrarComp(file, 'zvz-standard'), CtaCompError);
});

test('claves de rol/categoría duplicadas (case-insensitive) se rechazan', async () => {
  const file = tempFile();
  const comp = compValida();
  comp.roles['MAZA-PESADA'] = comp.roles['maza-pesada']; // duplica "maza-pesada" con otro casing
  await assert.rejects(() => guardarComp(file, 'zvz-standard', comp), CtaCompError);
});

test('emoji de categoría como código corto (":morado:") se rechaza: debe venir ya resuelto', async () => {
  const file = tempFile();
  const comp = compValida();
  comp.categorias.caller.emoji = ':morado:';
  await assert.rejects(() => guardarComp(file, 'zvz-standard', comp), CtaCompError);
});

test('emoji custom mal formado (le falta el id) se rechaza', async () => {
  const file = tempFile();
  const comp = compValida();
  comp.roles.hoj.emoji = '<:hoj>';
  await assert.rejects(() => guardarComp(file, 'zvz-standard', comp), CtaCompError);
});

test('dos categorías no pueden compartir el mismo emoji', async () => {
  const file = tempFile();
  const comp = compValida();
  comp.categorias.tanque.emoji = comp.categorias.caller.emoji; // 🟣 repetido
  await assert.rejects(() => guardarComp(file, 'zvz-standard', comp), CtaCompError);
});

test('un rol referenciando una categoría inexistente se rechaza', async () => {
  const file = tempFile();
  const comp = compValida();
  comp.roles.santi.categoria = 'no-existe';
  await assert.rejects(() => guardarComp(file, 'zvz-standard', comp), CtaCompError);
});

test('un slot de party referenciando un rol inexistente se rechaza', async () => {
  const file = tempFile();
  const comp = compValida();
  comp.parties[0].slots.push('rol-fantasma');
  await assert.rejects(() => guardarComp(file, 'zvz-standard', comp), CtaCompError);
});

test('más de 25 roles se rechaza (límite de un select menu de Discord)', async () => {
  const file = tempFile();
  const comp = compValida();
  for (let i = 0; i < 22; i++) {
    comp.roles[`extra-${i}`] = { nombre: `Extra ${i}`, emoji: '⭐' };
  }
  assert.equal(Object.keys(comp.roles).length, 26);
  await assert.rejects(() => guardarComp(file, 'zvz-standard', comp), CtaCompError);
});

test('más de 20 parties se rechaza (límite de fields de un embed)', async () => {
  const file = tempFile();
  const comp = compValida();
  comp.parties = Array.from({ length: 21 }, (_, i) => ({ nombre: `Party ${i + 1}`, slots: ['perma'] }));
  await assert.rejects(() => guardarComp(file, 'zvz-standard', comp), CtaCompError);
});

test('guardarComp inválido no toca el fichero (valida antes de escribir)', async () => {
  const file = tempFile();
  await guardarComp(file, 'zvz-standard', compValida());
  const antes = await listarComps(file);

  const comp = compValida();
  comp.roles.hoj.emoji = ':morado:'; // inválido
  await assert.rejects(() => guardarComp(file, 'otra-comp', comp), CtaCompError);

  const despues = await listarComps(file);
  assert.deepEqual(despues, antes); // "otra-comp" nunca se escribió
});
