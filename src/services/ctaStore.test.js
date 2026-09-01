import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  ctaActiva,
  estaApuntado,
  crearCta,
  apuntar,
  desapuntar,
  cerrarCta,
  marcarSincronizacion,
  CtaError,
} from './ctaStore.js';

let dir;
let n = 0;

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'ctastore-test-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Cada test usa su propio fichero, así no interfieren entre sí ni dependen
// del orden de ejecución.
function freshPath() {
  return path.join(dir, `cta-${n++}.json`);
}

const futureIso = (minutes = 60) => new Date(Date.now() + minutes * 60_000).toISOString();

function datosBase(overrides = {}) {
  return {
    nombre: 'Hellgate',
    guildId: 'g1',
    channelId: 'c1',
    messageId: 'm1',
    creadorId: 'u1',
    cierraEn: futureIso(),
    ...overrides,
  };
}

// --- lectura sobre fichero inexistente ---

test('ctaActiva()/estaApuntado() devuelven null/false si cta.json no existe', async () => {
  const filePath = freshPath();
  assert.equal(await ctaActiva(filePath), null);
  assert.equal(await estaApuntado(filePath, 'u1'), false);
});

// --- crearCta: validación ---

test('crearCta() exige nombre/guildId/channelId/messageId/creadorId/cierraEn', async () => {
  const filePath = freshPath();
  for (const field of ['nombre', 'guildId', 'channelId', 'messageId', 'creadorId', 'cierraEn']) {
    const datos = datosBase();
    delete datos[field];
    await assert.rejects(() => crearCta(filePath, datos), (err) => {
      assert.ok(err instanceof CtaError);
      assert.match(err.message, new RegExp(`Falta "${field}"`));
      return true;
    });
  }
});

test('crearCta() rechaza cierraEn inválido o no futuro', async () => {
  const filePath = freshPath();
  await assert.rejects(() => crearCta(filePath, datosBase({ cierraEn: 'no-es-fecha' })), /no es una fecha válida/);
  await assert.rejects(
    () => crearCta(filePath, datosBase({ cierraEn: new Date(Date.now() - 1000).toISOString() })),
    /fecha futura/,
  );
});

test('crearCta() genera id "cta_<timestamp>" si no se pasa uno, y guarda roleId/roleNombre en null si no se pasan', async () => {
  const filePath = freshPath();
  const activa = await crearCta(filePath, datosBase());

  assert.match(activa.id, /^cta_\d+$/);
  assert.equal(activa.nombre, 'Hellgate');
  assert.equal(activa.roleId, null);
  assert.equal(activa.roleNombre, null);
  assert.equal(activa.sincronizada, true);
  assert.deepEqual(activa.inscritos, []);

  const onDisk = JSON.parse(await readFile(filePath, 'utf8'));
  assert.deepEqual(onDisk.activa, activa);
});

test('crearCta() acepta un id y roleId/roleNombre explícitos', async () => {
  const filePath = freshPath();
  const activa = await crearCta(filePath, datosBase({ id: 'cta_fijo', roleId: 'role-1', roleNombre: 'Hellgate_0101-0000' }));
  assert.equal(activa.id, 'cta_fijo');
  assert.equal(activa.roleId, 'role-1');
  assert.equal(activa.roleNombre, 'Hellgate_0101-0000');
});

test('crearCta() falla si ya hay una activa, indicando canal y hora de cierre', async () => {
  const filePath = freshPath();
  const primera = await crearCta(filePath, datosBase({ channelId: 'canal-original' }));
  const cierraEnSeconds = Math.floor(new Date(primera.cierraEn).getTime() / 1000);

  await assert.rejects(() => crearCta(filePath, datosBase()), (err) => {
    assert.ok(err instanceof CtaError);
    assert.match(err.message, /<#canal-original>/);
    assert.match(err.message, new RegExp(`<t:${cierraEnSeconds}:R>`));
    assert.match(err.message, /Solo puede haber una CTA a la vez/);
    return true;
  });
});

// --- apuntar ---

test('apuntar() añade en orden de llamada y sin CTA activa lanza CtaError', async () => {
  const filePath = freshPath();
  await assert.rejects(() => apuntar(filePath, 'u1', 'Uno', ['Tank', 'Healer', 'DPS']), /No hay ninguna CTA activa/);

  await crearCta(filePath, datosBase());
  await apuntar(filePath, 'u1', 'Uno', ['Tank', 'Healer', 'DPS']);
  await apuntar(filePath, 'u2', 'Dos', ['Support', 'DPS', 'Scout']);

  const activa = await ctaActiva(filePath);
  assert.deepEqual(
    activa.inscritos.map((i) => i.userId),
    ['u1', 'u2'],
  );
  assert.equal(await estaApuntado(filePath, 'u1'), true);
  assert.equal(await estaApuntado(filePath, 'u3'), false);
});

test('apuntar() con un userId ya inscrito actualiza nombre/roles SIN mover su posición (mismo ts) ni duplicar', async () => {
  const filePath = freshPath();
  await crearCta(filePath, datosBase());
  await apuntar(filePath, 'u1', 'Uno', ['Tank', 'Healer', 'DPS']);
  await apuntar(filePath, 'u2', 'Dos', ['Support', 'DPS', 'Scout']);

  const antes = await ctaActiva(filePath);
  const tsOriginal = antes.inscritos[0].ts;

  await apuntar(filePath, 'u1', 'Uno (renombrado)', ['Scout', 'Tank', 'Healer']);

  const despues = await ctaActiva(filePath);
  assert.equal(despues.inscritos.length, 2, 'un userId no puede aparecer dos veces');
  assert.deepEqual(
    despues.inscritos.map((i) => i.userId),
    ['u1', 'u2'],
    'la posición no debe cambiar',
  );
  assert.equal(despues.inscritos[0].ts, tsOriginal, 'el ts no debe cambiar al reinscribirse');
  assert.deepEqual(despues.inscritos[0].roles, ['Scout', 'Tank', 'Healer']);
  assert.equal(despues.inscritos[0].nombre, 'Uno (renombrado)');
});

test('apuntar() valida userId/nombre/roles', async () => {
  const filePath = freshPath();
  await crearCta(filePath, datosBase());
  await assert.rejects(() => apuntar(filePath, '', 'Uno', []), /Falta userId/);
  await assert.rejects(() => apuntar(filePath, 'u1', '', []), /Falta nombre/);
  await assert.rejects(() => apuntar(filePath, 'u1', 'Uno', 'no-es-array'), /roles debe ser un array/);
});

// --- desapuntar ---

test('desapuntar() quita al jugador correcto y preserva el orden del resto', async () => {
  const filePath = freshPath();
  await crearCta(filePath, datosBase());
  await apuntar(filePath, 'u1', 'Uno', ['Tank', 'Healer', 'DPS']);
  await apuntar(filePath, 'u2', 'Dos', ['Support', 'DPS', 'Scout']);
  await apuntar(filePath, 'u3', 'Tres', ['Tank', 'Support', 'DPS']);

  await desapuntar(filePath, 'u2');

  const activa = await ctaActiva(filePath);
  assert.deepEqual(
    activa.inscritos.map((i) => i.userId),
    ['u1', 'u3'],
  );
});

test('desapuntar() sin estar apuntado lanza CtaError y no modifica el fichero', async () => {
  const filePath = freshPath();
  await crearCta(filePath, datosBase());
  await apuntar(filePath, 'u1', 'Uno', ['Tank', 'Healer', 'DPS']);
  const antes = await readFile(filePath, 'utf8');

  await assert.rejects(() => desapuntar(filePath, 'no-existe'), /No estás apuntado/);

  const despues = await readFile(filePath, 'utf8');
  assert.equal(antes, despues, 'un intento de desapuntar a quien no está inscrito no debe tocar el fichero');
});

test('desapuntar() sin CTA activa lanza CtaError', async () => {
  const filePath = freshPath();
  await assert.rejects(() => desapuntar(filePath, 'u1'), /No hay ninguna CTA activa/);
});

// --- cerrarCta ---

test('cerrarCta() deja activa=null y devuelve la CTA cerrada; permite crear una nueva después', async () => {
  const filePath = freshPath();
  await crearCta(filePath, datosBase());
  await apuntar(filePath, 'u1', 'Uno', ['Tank', 'Healer', 'DPS']);

  const cerrada = await cerrarCta(filePath);
  assert.equal(cerrada.inscritos.length, 1);
  assert.equal(await ctaActiva(filePath), null);

  const onDisk = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(onDisk.activa, null);

  // no debe fallar por "ya hay una activa"
  const nueva = await crearCta(filePath, datosBase({ nombre: 'Otra' }));
  assert.notEqual(nueva.id, cerrada.id);
});

test('cerrarCta() sin CTA activa lanza CtaError', async () => {
  const filePath = freshPath();
  await assert.rejects(() => cerrarCta(filePath), /No hay ninguna CTA activa/);
});

// --- marcarSincronizacion ---

test('marcarSincronizacion() cambia el flag y devuelve la CTA actualizada solo si hubo cambio', async () => {
  const filePath = freshPath();
  const activa = await crearCta(filePath, datosBase());
  assert.equal(activa.sincronizada, true);

  const sinCambios = await marcarSincronizacion(filePath, activa.id, true);
  assert.equal(sinCambios, null, 'no debe escribir nada si el valor ya era el mismo');

  const marcada = await marcarSincronizacion(filePath, activa.id, false);
  assert.ok(marcada);
  assert.equal(marcada.sincronizada, false);
  assert.equal((await ctaActiva(filePath)).sincronizada, false);

  const restaurada = await marcarSincronizacion(filePath, activa.id, true);
  assert.equal(restaurada.sincronizada, true);
});

test('marcarSincronizacion() devuelve null si no hay CTA activa o el id no coincide (pudo cerrar entretanto)', async () => {
  const filePath = freshPath();
  assert.equal(await marcarSincronizacion(filePath, 'cta_inexistente', false), null);

  const activa = await crearCta(filePath, datosBase());
  assert.equal(await marcarSincronizacion(filePath, 'otro-id-distinto', false), null);
  assert.equal((await ctaActiva(filePath)).sincronizada, true, 'no debe haberse tocado');

  await cerrarCta(filePath);
  assert.equal(await marcarSincronizacion(filePath, activa.id, false), null);
});

// --- backups ---

test('cada mutación deja un backup y nunca supera 10', async () => {
  const filePath = freshPath();
  await crearCta(filePath, datosBase());
  for (let i = 0; i < 15; i++) {
    await apuntar(filePath, `u${i}`, `Jugador${i}`, ['Tank', 'Healer', 'DPS']);
  }

  const { readdir } = await import('node:fs/promises');
  const backupDir = path.join(path.dirname(filePath), 'backups');
  const entries = (await readdir(backupDir)).filter((name) => name.startsWith('cta-') && name.endsWith('.json'));
  assert.ok(entries.length > 0);
  assert.ok(entries.length <= 10, `esperaba <=10 backups, hay ${entries.length}`);
});

// --- mutex: dos mutaciones concurrentes sobre el mismo fichero no se pisan ---

test('dos apuntar() concurrentes (mismo fichero, usuarios distintos) no se pierden entre sí', async () => {
  const filePath = freshPath();
  await crearCta(filePath, datosBase());

  await Promise.all([
    apuntar(filePath, 'ua', 'Alpha', ['Tank', 'Healer', 'DPS']),
    apuntar(filePath, 'ub', 'Beta', ['Support', 'DPS', 'Scout']),
  ]);

  const activa = await ctaActiva(filePath);
  assert.equal(activa.inscritos.length, 2);
  assert.deepEqual(new Set(activa.inscritos.map((i) => i.userId)), new Set(['ua', 'ub']));
});
