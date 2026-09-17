import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  crearComp,
  agregarOActualizarCategoria,
  borrarCategoria,
  crearRoles,
  borrarRoles,
  moverRoles,
  agregarParty,
  borrarParty,
  duplicarParty,
  agregarSlot,
  borrarSlot,
  getComp,
  CtaCompError,
} from './ctaComp.js';

const DIR = await mkdtemp(path.join(os.tmpdir(), 'ctacomp-granular-test-'));
let fileCounter = 0;
function tempFile() {
  return path.join(DIR, `comps-${fileCounter++}.json`);
}

after(async () => {
  await rm(DIR, { recursive: true, force: true });
});

// Identidad: en estos tests los emojis "crudos" ya vienen resueltos (así se
// prueba ctaComp.js aislado de discord.js); emojiResolver.js tiene sus
// propios tests.
const resuelveTalCual = (crudo) => crudo;
function fallaResolucion() {
  throw new Error('emoji no encontrado (forzado para el test)');
}

test('crearComp: deriva el slug del nombre y empieza vacía', async () => {
  const file = tempFile();
  const { key, comp } = await crearComp(file, { nombre: 'ZvZ Standard', creadoPor: 'off-1' });

  assert.equal(key, 'zvz-standard');
  assert.equal(comp.nombre, 'ZvZ Standard');
  assert.deepEqual(comp.categorias, {});
  assert.deepEqual(comp.roles, {});
  assert.deepEqual(comp.parties, []);
});

test('crearComp: si el slug ya existe, añade un sufijo numérico sin pedir un id', async () => {
  const file = tempFile();
  const a = await crearComp(file, { nombre: 'ZvZ Standard', creadoPor: 'off-1' });
  const b = await crearComp(file, { nombre: 'ZvZ Standard', creadoPor: 'off-1' });
  const c = await crearComp(file, { nombre: 'ZvZ Standard', creadoPor: 'off-1' });

  assert.equal(a.key, 'zvz-standard');
  assert.equal(b.key, 'zvz-standard-2');
  assert.equal(c.key, 'zvz-standard-3');
});

test('agregarOActualizarCategoria: crea, y re-ejecutar con el mismo nombre ACTUALIZA el emoji sin fallar', async () => {
  const file = tempFile();
  const { key } = await crearComp(file, { nombre: 'Comp', creadoPor: 'off-1' });

  const primera = await agregarOActualizarCategoria(
    file, key, { nombre: 'Caller', emojiCrudo: '🟣' }, { resolverEmoji: resuelveTalCual },
  );
  assert.equal(primera.actualizado, false);
  assert.equal(primera.categoriaKey, 'caller');
  assert.equal(primera.categoria.emoji, '🟣');
  assert.equal(primera.categoria.orden, 1);

  const segunda = await agregarOActualizarCategoria(
    file, key, { nombre: 'Caller', emojiCrudo: '🔴' }, { resolverEmoji: resuelveTalCual },
  );
  assert.equal(segunda.actualizado, true);
  assert.equal(segunda.categoria.emoji, '🔴');
  assert.equal(segunda.categoria.orden, 1); // el orden no se resetea al actualizar
});

test('agregarOActualizarCategoria: el orden crece automáticamente con cada categoría NUEVA', async () => {
  const file = tempFile();
  const { key } = await crearComp(file, { nombre: 'Comp', creadoPor: 'off-1' });

  const c1 = await agregarOActualizarCategoria(file, key, { nombre: 'Caller', emojiCrudo: '🟣' }, { resolverEmoji: resuelveTalCual });
  const c2 = await agregarOActualizarCategoria(file, key, { nombre: 'Tanque', emojiCrudo: '🔵' }, { resolverEmoji: resuelveTalCual });
  const c3 = await agregarOActualizarCategoria(file, key, { nombre: 'Soporte', emojiCrudo: '🟢' }, { resolverEmoji: resuelveTalCual });

  assert.deepEqual([c1.categoria.orden, c2.categoria.orden, c3.categoria.orden], [1, 2, 3]);
});

test('agregarOActualizarCategoria: rechaza un emoji ya usado por OTRA categoría', async () => {
  const file = tempFile();
  const { key } = await crearComp(file, { nombre: 'Comp', creadoPor: 'off-1' });
  await agregarOActualizarCategoria(file, key, { nombre: 'Caller', emojiCrudo: '🟣' }, { resolverEmoji: resuelveTalCual });

  await assert.rejects(
    () => agregarOActualizarCategoria(file, key, { nombre: 'Tanque', emojiCrudo: '🟣' }, { resolverEmoji: resuelveTalCual }),
    CtaCompError,
  );
});

test('agregarOActualizarCategoria: sobre una comp inexistente falla con code comp_not_found', async () => {
  const file = tempFile();
  await assert.rejects(async () => {
    try {
      await agregarOActualizarCategoria(file, 'no-existe', { nombre: 'Caller', emojiCrudo: '🟣' }, { resolverEmoji: resuelveTalCual });
    } catch (error) {
      assert.equal(error.code, 'comp_not_found');
      throw error;
    }
  }, CtaCompError);
});

test('borrarCategoria: rechaza si algún rol la usa, nombrándolo; borra cuando queda libre', async () => {
  const file = tempFile();
  const { key } = await crearComp(file, { nombre: 'Comp', creadoPor: 'off-1' });
  await agregarOActualizarCategoria(file, key, { nombre: 'Tanque', emojiCrudo: '🔵' }, { resolverEmoji: resuelveTalCual });
  await crearRoles(file, key, 'tanque', [{ nombre: 'Maza Pesada', emojiCrudo: '🔨' }], { resolverEmoji: resuelveTalCual });

  await assert.rejects(() => borrarCategoria(file, key, 'tanque'), CtaCompError);

  await borrarRoles(file, key, ['maza-pesada']);
  const { categoria } = await borrarCategoria(file, key, 'tanque');
  assert.equal(categoria.nombre, 'Tanque');

  const comp = await getComp(file, key);
  assert.equal(comp.categorias.tanque, undefined);
});

test('crearRoles: crea varios de una vez, emparejados con su categoría', async () => {
  const file = tempFile();
  const { key } = await crearComp(file, { nombre: 'Comp', creadoPor: 'off-1' });
  await agregarOActualizarCategoria(file, key, { nombre: 'Tanque', emojiCrudo: '🔵' }, { resolverEmoji: resuelveTalCual });

  const { creados } = await crearRoles(
    file, key, 'tanque',
    [
      { nombre: 'Maza Pesada', emojiCrudo: '🔨' },
      { nombre: 'Martillo Largo', emojiCrudo: '🛠️' },
    ],
    { resolverEmoji: resuelveTalCual },
  );

  assert.deepEqual(creados.map((r) => r.key), ['maza-pesada', 'martillo-largo']);

  const comp = await getComp(file, key);
  assert.equal(comp.roles['maza-pesada'].categoria, 'tanque');
  assert.equal(comp.roles['martillo-largo'].emoji, '🛠️');
});

test('crearRoles: si un nombre choca con un rol EXISTENTE, rechaza el lote entero (no crea ninguno)', async () => {
  const file = tempFile();
  const { key } = await crearComp(file, { nombre: 'Comp', creadoPor: 'off-1' });
  await agregarOActualizarCategoria(file, key, { nombre: 'Tanque', emojiCrudo: '🔵' }, { resolverEmoji: resuelveTalCual });
  await crearRoles(file, key, 'tanque', [{ nombre: 'Maza Pesada', emojiCrudo: '🔨' }], { resolverEmoji: resuelveTalCual });

  await assert.rejects(
    () =>
      crearRoles(
        file, key, 'tanque',
        [
          { nombre: 'Golem', emojiCrudo: '🗿' },
          { nombre: 'Maza Pesada', emojiCrudo: '🔨' }, // choca
        ],
        { resolverEmoji: resuelveTalCual },
      ),
    CtaCompError,
  );

  const comp = await getComp(file, key);
  assert.equal(comp.roles.golem, undefined); // "Golem" tampoco se creó: todo o nada
});

test('crearRoles: si dos nombres del MISMO lote chocan entre sí, rechaza el lote entero', async () => {
  const file = tempFile();
  const { key } = await crearComp(file, { nombre: 'Comp', creadoPor: 'off-1' });
  await agregarOActualizarCategoria(file, key, { nombre: 'Tanque', emojiCrudo: '🔵' }, { resolverEmoji: resuelveTalCual });

  await assert.rejects(
    () =>
      crearRoles(
        file, key, 'tanque',
        [
          { nombre: 'Maza Pesada', emojiCrudo: '🔨' },
          { nombre: 'maza pesada', emojiCrudo: '🔧' }, // mismo slug tras normalizar
        ],
        { resolverEmoji: resuelveTalCual },
      ),
    CtaCompError,
  );

  const comp = await getComp(file, key);
  assert.deepEqual(comp.roles, {});
});

test('crearRoles: si un emoji no resuelve, rechaza el lote entero', async () => {
  const file = tempFile();
  const { key } = await crearComp(file, { nombre: 'Comp', creadoPor: 'off-1' });
  await agregarOActualizarCategoria(file, key, { nombre: 'Tanque', emojiCrudo: '🔵' }, { resolverEmoji: resuelveTalCual });

  await assert.rejects(
    () =>
      crearRoles(
        file, key, 'tanque',
        [
          { nombre: 'Maza Pesada', emojiCrudo: '🔨' },
          { nombre: 'Martillo Largo', emojiCrudo: ':no-existe:' },
        ],
        { resolverEmoji: fallaResolucion },
      ),
  );

  const comp = await getComp(file, key);
  assert.deepEqual(comp.roles, {});
});

test('crearRoles: exige que la categoría exista (créala primero)', async () => {
  const file = tempFile();
  const { key } = await crearComp(file, { nombre: 'Comp', creadoPor: 'off-1' });

  await assert.rejects(async () => {
    try {
      await crearRoles(file, key, 'no-existe', [{ nombre: 'Maza Pesada', emojiCrudo: '🔨' }], { resolverEmoji: resuelveTalCual });
    } catch (error) {
      assert.equal(error.code, 'categoria_not_found');
      throw error;
    }
  }, CtaCompError);
});

test('borrarRoles: rechaza si algún rol está en uso, diciendo en cuántos slots', async () => {
  const file = tempFile();
  const { key } = await crearComp(file, { nombre: 'Comp', creadoPor: 'off-1' });
  await agregarOActualizarCategoria(file, key, { nombre: 'Tanque', emojiCrudo: '🔵' }, { resolverEmoji: resuelveTalCual });
  await crearRoles(file, key, 'tanque', [{ nombre: 'Maza Pesada', emojiCrudo: '🔨' }], { resolverEmoji: resuelveTalCual });
  await agregarParty(file, key, { nombre: 'Party 1' });
  await agregarSlot(file, key, 0, 'maza-pesada', 2);

  await assert.rejects(async () => {
    try {
      await borrarRoles(file, key, ['maza-pesada']);
    } catch (error) {
      assert.equal(error.code, 'rol_en_uso');
      assert.equal(error.roles[0].count, 2);
      throw error;
    }
  }, CtaCompError);
});

test('borrarRoles: borra varios de una vez cuando ninguno está en uso', async () => {
  const file = tempFile();
  const { key } = await crearComp(file, { nombre: 'Comp', creadoPor: 'off-1' });
  await agregarOActualizarCategoria(file, key, { nombre: 'Tanque', emojiCrudo: '🔵' }, { resolverEmoji: resuelveTalCual });
  await crearRoles(
    file, key, 'tanque',
    [{ nombre: 'Maza Pesada', emojiCrudo: '🔨' }, { nombre: 'Golem', emojiCrudo: '🗿' }],
    { resolverEmoji: resuelveTalCual },
  );

  const { borrados } = await borrarRoles(file, key, ['maza-pesada', 'golem']);
  assert.equal(borrados.length, 2);

  const comp = await getComp(file, key);
  assert.deepEqual(comp.roles, {});
});

test('moverRoles: cambia de categoría uno o varios roles a la vez', async () => {
  const file = tempFile();
  const { key } = await crearComp(file, { nombre: 'Comp', creadoPor: 'off-1' });
  await agregarOActualizarCategoria(file, key, { nombre: 'Tanque', emojiCrudo: '🔵' }, { resolverEmoji: resuelveTalCual });
  await agregarOActualizarCategoria(file, key, { nombre: 'Caller', emojiCrudo: '🟣' }, { resolverEmoji: resuelveTalCual });
  await crearRoles(
    file, key, 'tanque',
    [{ nombre: 'Maza Pesada', emojiCrudo: '🔨' }, { nombre: 'Golem', emojiCrudo: '🗿' }],
    { resolverEmoji: resuelveTalCual },
  );

  const { movidos } = await moverRoles(file, key, ['maza-pesada', 'golem'], 'caller');
  assert.equal(movidos.length, 2);

  const comp = await getComp(file, key);
  assert.equal(comp.roles['maza-pesada'].categoria, 'caller');
  assert.equal(comp.roles.golem.categoria, 'caller');
});

test('agregarParty + duplicarParty: la copia es independiente de la original', async () => {
  const file = tempFile();
  const { key } = await crearComp(file, { nombre: 'Comp', creadoPor: 'off-1' });
  await agregarOActualizarCategoria(file, key, { nombre: 'Tanque', emojiCrudo: '🔵' }, { resolverEmoji: resuelveTalCual });
  await crearRoles(file, key, 'tanque', [{ nombre: 'Maza Pesada', emojiCrudo: '🔨' }], { resolverEmoji: resuelveTalCual });

  const { indice } = await agregarParty(file, key, { nombre: 'Party 1' });
  assert.equal(indice, 0);
  await agregarSlot(file, key, 0, 'maza-pesada', 2);

  const { indiceNuevo, party } = await duplicarParty(file, key, 0);
  assert.equal(indiceNuevo, 1);
  assert.equal(party.nombre, 'Party 1 (copia)');
  assert.deepEqual(party.slots, ['maza-pesada', 'maza-pesada']);

  await agregarSlot(file, key, 0, 'maza-pesada', 1); // solo a la original

  const comp = await getComp(file, key);
  assert.equal(comp.parties[0].slots.length, 3);
  assert.equal(comp.parties[1].slots.length, 2); // la copia no se enteró
});

test('borrarParty: sobre un índice fuera de rango falla con code party_not_found', async () => {
  const file = tempFile();
  const { key } = await crearComp(file, { nombre: 'Comp', creadoPor: 'off-1' });
  await agregarParty(file, key, { nombre: 'Party 1' });

  await assert.rejects(async () => {
    try {
      await borrarParty(file, key, 5);
    } catch (error) {
      assert.equal(error.code, 'party_not_found');
      throw error;
    }
  }, CtaCompError);
});

test('agregarSlot: cantidad añade varios slots del mismo rol de una vez', async () => {
  const file = tempFile();
  const { key } = await crearComp(file, { nombre: 'Comp', creadoPor: 'off-1' });
  await agregarOActualizarCategoria(file, key, { nombre: 'Caller', emojiCrudo: '🟣' }, { resolverEmoji: resuelveTalCual });
  await crearRoles(file, key, 'caller', [{ nombre: 'HOJ', emojiCrudo: '⚖️' }], { resolverEmoji: resuelveTalCual });
  await agregarParty(file, key, { nombre: 'Party 1' });

  const { party } = await agregarSlot(file, key, 0, 'hoj', 3);
  assert.deepEqual(party.slots, ['hoj', 'hoj', 'hoj']);
});

test('borrarSlot: borra un slot concreto por índice', async () => {
  const file = tempFile();
  const { key } = await crearComp(file, { nombre: 'Comp', creadoPor: 'off-1' });
  await agregarOActualizarCategoria(file, key, { nombre: 'Tanque', emojiCrudo: '🔵' }, { resolverEmoji: resuelveTalCual });
  await crearRoles(
    file, key, 'tanque',
    [{ nombre: 'Maza Pesada', emojiCrudo: '🔨' }, { nombre: 'Golem', emojiCrudo: '🗿' }],
    { resolverEmoji: resuelveTalCual },
  );
  await agregarParty(file, key, { nombre: 'Party 1' });
  await agregarSlot(file, key, 0, 'maza-pesada', 1);
  await agregarSlot(file, key, 0, 'golem', 1);

  const { rolKey } = await borrarSlot(file, key, 0, 0);
  assert.equal(rolKey, 'maza-pesada');

  const comp = await getComp(file, key);
  assert.deepEqual(comp.parties[0].slots, ['golem']);
});

test('flujo completo PASO 1 -> 2 -> 3 -> parties -> slots produce una comp válida y consultable', async () => {
  const file = tempFile();
  const { key } = await crearComp(file, { nombre: 'ZvZ Standard', creadoPor: 'off-1' });
  await agregarOActualizarCategoria(file, key, { nombre: 'Caller', emojiCrudo: '🟣' }, { resolverEmoji: resuelveTalCual });
  await agregarOActualizarCategoria(file, key, { nombre: 'Tanque', emojiCrudo: '🔵' }, { resolverEmoji: resuelveTalCual });
  await crearRoles(file, key, 'caller', [{ nombre: 'HOJ', emojiCrudo: '⚖️' }], { resolverEmoji: resuelveTalCual });
  await crearRoles(file, key, 'tanque', [{ nombre: 'Maza Pesada', emojiCrudo: '🔨' }], { resolverEmoji: resuelveTalCual });
  await agregarParty(file, key, { nombre: 'Party 1' });
  await agregarSlot(file, key, 0, 'maza-pesada', 1);
  await agregarSlot(file, key, 0, 'hoj', 1);

  const comp = await getComp(file, key);
  assert.equal(Object.keys(comp.categorias).length, 2);
  assert.equal(Object.keys(comp.roles).length, 2);
  assert.equal(comp.parties.length, 1);
  assert.deepEqual(comp.parties[0].slots, ['maza-pesada', 'hoj']);
});

test('más de 20 parties por la vía incremental (agregarParty) se rechaza', async () => {
  const file = tempFile();
  const { key } = await crearComp(file, { nombre: 'Comp', creadoPor: 'off-1' });

  for (let i = 0; i < 20; i++) {
    await agregarParty(file, key, { nombre: `Party ${i + 1}` });
  }

  await assert.rejects(() => agregarParty(file, key, { nombre: 'Party 21' }), CtaCompError);
});
