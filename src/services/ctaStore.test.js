import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  crearCta,
  actualizarCta,
  cerrarCta,
  ctaDeCanal,
  ctaPorId,
  ctasActivas,
  inscribir,
  desinscribir,
  asignar,
  desasignar,
  mover,
  bloquear,
  autorrellenar,
  slotsLibres,
  sinAsignar,
  rolesQueFaltan,
  migrarCtaSiHaceFalta,
  marcarLocalizable,
  guardarCierrePendiente,
  pendienteDeVolcarDeCanal,
  quitarCierrePendiente,
  CtaError,
} from './ctaStore.js';

const DIR = await mkdtemp(path.join(os.tmpdir(), 'ctastore-test-'));
let fileCounter = 0;
function tempFile() {
  return path.join(DIR, `cta-${fileCounter++}.json`);
}

after(async () => {
  await rm(DIR, { recursive: true, force: true });
});

function compFixture() {
  return {
    nombre: 'ZvZ Standard',
    categorias: {
      caller: { nombre: 'Caller', emoji: '🟣', orden: 1 },
      tanque: { nombre: 'Tanque', emoji: '🔵', orden: 2 },
    },
    roles: {
      'maza-pesada': { nombre: 'Maza Pesada', emoji: '🔨', categoria: 'tanque', nota: '' },
      hoj: { nombre: 'HOJ', emoji: '⚖️', categoria: 'caller', nota: '' },
      santi: { nombre: 'Santi', emoji: '🧪', categoria: null, nota: '' },
    },
    parties: [
      { nombre: 'Party 1', slots: ['maza-pesada', 'hoj', 'santi'] },
      { nombre: 'Party 2', slots: ['maza-pesada', 'santi'] },
    ],
  };
}

function datosBase(overrides = {}) {
  return {
    nombre: 'Hellgate 5v5',
    compId: 'zvz-standard',
    comp: compFixture(),
    modo: 'self',
    guildId: 'guild-1',
    channelId: `chan-${fileCounter}`, // único por defecto para no chocar entre tests que reusan datosBase()
    creadorId: 'user-creator',
    cierraEn: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  };
}

test('crearCta: copia la plantilla, no la referencia', async () => {
  const file = tempFile();
  const comp = compFixture();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-copy', comp }));

  comp.roles['maza-pesada'].nombre = 'MUTADO';
  comp.parties[0].slots.push('hoj');

  const releida = await ctaPorId(file, cta.id);
  assert.equal(releida.comp.roles['maza-pesada'].nombre, 'Maza Pesada');
  assert.equal(releida.comp.parties[0].slots.length, 3);
});

test('crearCta: empieza sin no localizables', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-init' }));
  assert.deepEqual(cta.noLocalizables, []);
});

test('marcarLocalizable: añade y quita de la lista de no localizables sin duplicar', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-localizable' }));

  await marcarLocalizable(file, cta.id, 'u1', false);
  await marcarLocalizable(file, cta.id, 'u1', false); // repetido: no duplica
  let cargada = await ctaPorId(file, cta.id);
  assert.deepEqual(cargada.noLocalizables, ['u1']);

  await marcarLocalizable(file, cta.id, 'u1', true); // un DM posterior sí llegó
  cargada = await ctaPorId(file, cta.id);
  assert.deepEqual(cargada.noLocalizables, []);
});

test('crearCta: rechaza una segunda CTA en el mismo canal, pero permite en canales distintos', async () => {
  const file = tempFile();
  await crearCta(file, datosBase({ channelId: 'chan-a' }));
  await assert.rejects(() => crearCta(file, datosBase({ channelId: 'chan-a' })), CtaError);

  const otra = await crearCta(file, datosBase({ channelId: 'chan-b' }));
  assert.ok(otra.id);

  const activas = await ctasActivas(file);
  assert.equal(activas.length, 2);
});

test('modo "caller" exige callerId', async () => {
  const file = tempFile();
  await assert.rejects(() => crearCta(file, datosBase({ channelId: 'chan-c', modo: 'caller' })), CtaError);
  const ok = await crearCta(file, datosBase({ channelId: 'chan-c', modo: 'caller', callerId: 'user-caller' }));
  assert.equal(ok.callerId, 'user-caller');
});

test('resolución por ctaId, no por canal: ctaPorId encuentra la CTA aunque haya otra activa en otro canal', async () => {
  const file = tempFile();
  const a = await crearCta(file, datosBase({ channelId: 'chan-x' }));
  const b = await crearCta(file, datosBase({ channelId: 'chan-y' }));

  assert.equal((await ctaPorId(file, a.id)).channelId, 'chan-x');
  assert.equal((await ctaPorId(file, b.id)).channelId, 'chan-y');
  assert.equal((await ctaDeCanal(file, 'chan-x')).id, a.id);
  assert.equal(await ctaDeCanal(file, 'chan-no-existe'), null);
});

test('actualizarCta: solo campos de la lista blanca', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-patch' }));

  const actualizada = await actualizarCta(file, cta.id, { messageId: 'msg-1', roleId: 'role-1' });
  assert.equal(actualizada.messageId, 'msg-1');
  assert.equal(actualizada.roleId, 'role-1');

  await assert.rejects(() => actualizarCta(file, cta.id, { nombre: 'hackeo' }), CtaError);
});

test('inscribir: alta nueva, y reinscribir actualiza roles sin cambiar el ts', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-insc' }));

  const { inscrito, actualizado } = await inscribir(file, cta.id, {
    userId: 'u1',
    nombre: 'FokinFran',
    roles: ['maza-pesada', 'santi'],
    preferido: 'maza-pesada',
  });
  assert.equal(actualizado, false);
  const tsOriginal = inscrito.ts;

  await new Promise((resolve) => setTimeout(resolve, 5));

  const { inscrito: reinscrito, actualizado: actualizado2 } = await inscribir(file, cta.id, {
    userId: 'u1',
    nombre: 'FokinFran',
    roles: ['santi'],
    preferido: 'santi',
  });
  assert.equal(actualizado2, true);
  assert.equal(reinscrito.ts, tsOriginal);
  assert.deepEqual(reinscrito.roles, ['santi']);
});

test('inscribir: preferido por defecto es el primer rol declarado; preferido fuera de roles falla', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-pref' }));

  const { inscrito } = await inscribir(file, cta.id, { userId: 'u1', nombre: 'A', roles: ['hoj', 'santi'] });
  assert.equal(inscrito.preferido, 'hoj');

  await assert.rejects(
    () => inscribir(file, cta.id, { userId: 'u2', nombre: 'B', roles: ['hoj'], preferido: 'santi' }),
    CtaError,
  );
});

test('inscribir: un rol que no existe en la comp de esta CTA se rechaza', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-rolfantasma' }));
  await assert.rejects(
    () => inscribir(file, cta.id, { userId: 'u1', nombre: 'A', roles: ['rol-fantasma'] }),
    CtaError,
  );
});

test('inscribir: si el rol asignado deja de estar entre los declarados, se desasigna y se informa', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-desasig-insc' }));
  await inscribir(file, cta.id, { userId: 'u1', nombre: 'A', roles: ['maza-pesada', 'santi'] });
  await asignar(file, cta.id, { partyIdx: 0, slotIdx: 0, userId: 'u1' }); // slot 0:0 = maza-pesada

  const { desasignado } = await inscribir(file, cta.id, { userId: 'u1', nombre: 'A', roles: ['santi'] });
  assert.equal(desasignado, true);

  const cargada = await ctaPorId(file, cta.id);
  assert.deepEqual(cargada.asignaciones, {});
});

test('inscribir: si el rol asignado SIGUE entre los declarados, la asignación no se toca', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-mantiene-asig' }));
  await inscribir(file, cta.id, { userId: 'u1', nombre: 'A', roles: ['maza-pesada', 'santi'] });
  await asignar(file, cta.id, { partyIdx: 0, slotIdx: 0, userId: 'u1' });

  const { desasignado } = await inscribir(file, cta.id, { userId: 'u1', nombre: 'A', roles: ['maza-pesada'] });
  assert.equal(desasignado, false);

  const cargada = await ctaPorId(file, cta.id);
  assert.equal(cargada.asignaciones['0:0'].userId, 'u1');
});

test('desinscribir: libera el slot si tenía, y falla si no estaba inscrito', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-desinsc' }));
  await inscribir(file, cta.id, { userId: 'u1', nombre: 'A', roles: ['santi'] });
  await asignar(file, cta.id, { partyIdx: 0, slotIdx: 2, userId: 'u1' });

  const { liberoSlot } = await desinscribir(file, cta.id, 'u1');
  assert.equal(liberoSlot, true);

  const cargada = await ctaPorId(file, cta.id);
  assert.deepEqual(cargada.inscritos, []);
  assert.deepEqual(cargada.asignaciones, {});

  await assert.rejects(() => desinscribir(file, cta.id, 'u1'), CtaError);
});

test('claves de asignación: un usuario solo puede estar en una a la vez; reasignarlo es un movimiento', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-mov' }));
  await inscribir(file, cta.id, { userId: 'u1', nombre: 'A', roles: ['maza-pesada'] });

  await asignar(file, cta.id, { partyIdx: 0, slotIdx: 0, userId: 'u1' });
  const { movidoDesde } = await asignar(file, cta.id, { partyIdx: 1, slotIdx: 0, userId: 'u1' });

  assert.equal(movidoDesde, '0:0');
  const cargada = await ctaPorId(file, cta.id);
  assert.equal(cargada.asignaciones['0:0'], undefined);
  assert.equal(cargada.asignaciones['1:0'].userId, 'u1');
});

test('asignar: falla si el usuario no está inscrito, si el slot no existe, o si ya lo ocupa OTRO usuario', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-asig-falla' }));
  await inscribir(file, cta.id, { userId: 'u1', nombre: 'A', roles: ['maza-pesada'] });
  await inscribir(file, cta.id, { userId: 'u2', nombre: 'B', roles: ['maza-pesada'] });

  await assert.rejects(() => asignar(file, cta.id, { partyIdx: 0, slotIdx: 0, userId: 'no-inscrito' }), CtaError);
  await assert.rejects(() => asignar(file, cta.id, { partyIdx: 9, slotIdx: 0, userId: 'u1' }), CtaError);

  await asignar(file, cta.id, { partyIdx: 0, slotIdx: 0, userId: 'u1' });
  await assert.rejects(() => asignar(file, cta.id, { partyIdx: 0, slotIdx: 0, userId: 'u2' }), CtaError);
});

test('mover exige una asignación previa; asignar no la exige', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-mover-exige' }));
  await inscribir(file, cta.id, { userId: 'u1', nombre: 'A', roles: ['maza-pesada'] });

  await assert.rejects(() => mover(file, cta.id, { userId: 'u1', partyIdx: 0, slotIdx: 0 }), CtaError);

  await asignar(file, cta.id, { partyIdx: 0, slotIdx: 0, userId: 'u1' });
  await mover(file, cta.id, { userId: 'u1', partyIdx: 1, slotIdx: 0 });

  const cargada = await ctaPorId(file, cta.id);
  assert.equal(cargada.asignaciones['1:0'].userId, 'u1');
  assert.equal(cargada.asignaciones['0:0'], undefined);
});

test('mover: si el destino está ocupado por OTRO usuario, intercambia en vez de fallar', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-mover-swap' }));
  await inscribir(file, cta.id, { userId: 'u1', nombre: 'A', roles: ['maza-pesada'] });
  await inscribir(file, cta.id, { userId: 'u2', nombre: 'B', roles: ['maza-pesada'] });
  await asignar(file, cta.id, { partyIdx: 0, slotIdx: 0, userId: 'u1' });
  await asignar(file, cta.id, { partyIdx: 1, slotIdx: 0, userId: 'u2' });

  const { intercambiadoCon } = await mover(file, cta.id, { userId: 'u1', partyIdx: 1, slotIdx: 0 });
  assert.equal(intercambiadoCon, 'u2');

  const cargada = await ctaPorId(file, cta.id);
  assert.equal(cargada.asignaciones['1:0'].userId, 'u1');
  assert.equal(cargada.asignaciones['0:0'].userId, 'u2');
});

test('mover: mover a su propio slot es un no-op', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-mover-mismo' }));
  await inscribir(file, cta.id, { userId: 'u1', nombre: 'A', roles: ['maza-pesada'] });
  await asignar(file, cta.id, { partyIdx: 0, slotIdx: 0, userId: 'u1' });

  const { intercambiadoCon } = await mover(file, cta.id, { userId: 'u1', partyIdx: 0, slotIdx: 0 });
  assert.equal(intercambiadoCon, null);

  const cargada = await ctaPorId(file, cta.id);
  assert.equal(cargada.asignaciones['0:0'].userId, 'u1');
});

test('mover: no se puede mover a alguien fuera de un slot bloqueado, ni moverlo A uno bloqueado', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-mover-bloqueado' }));
  await inscribir(file, cta.id, { userId: 'u1', nombre: 'A', roles: ['maza-pesada'] });
  await inscribir(file, cta.id, { userId: 'u2', nombre: 'B', roles: ['maza-pesada'] });
  await asignar(file, cta.id, { partyIdx: 0, slotIdx: 0, userId: 'u1' });
  await asignar(file, cta.id, { partyIdx: 1, slotIdx: 0, userId: 'u2' });

  await bloquear(file, cta.id, { partyIdx: 0, slotIdx: 0, bloqueado: true });
  await assert.rejects(() => mover(file, cta.id, { userId: 'u1', partyIdx: 1, slotIdx: 0 }), CtaError);

  await bloquear(file, cta.id, { partyIdx: 0, slotIdx: 0, bloqueado: false });
  await bloquear(file, cta.id, { partyIdx: 1, slotIdx: 0, bloqueado: true });
  await assert.rejects(() => mover(file, cta.id, { userId: 'u1', partyIdx: 1, slotIdx: 0 }), CtaError);
});

test('desasignar libera una clave ocupada; sobre una clave vacía falla', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-desasig' }));
  await inscribir(file, cta.id, { userId: 'u1', nombre: 'A', roles: ['maza-pesada'] });
  await asignar(file, cta.id, { partyIdx: 0, slotIdx: 0, userId: 'u1' });

  await desasignar(file, cta.id, { partyIdx: 0, slotIdx: 0 });
  const cargada = await ctaPorId(file, cta.id);
  assert.deepEqual(cargada.asignaciones, {});

  await assert.rejects(() => desasignar(file, cta.id, { partyIdx: 0, slotIdx: 0 }), CtaError);
});

test('bloquear: no se puede bloquear un slot vacío; bloqueado, asignar/mover lo rechazan; autorrellenar no lo toca', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-bloq' }));
  await inscribir(file, cta.id, { userId: 'u1', nombre: 'A', roles: ['maza-pesada'] });
  await inscribir(file, cta.id, { userId: 'u2', nombre: 'B', roles: ['maza-pesada'] });

  await assert.rejects(() => bloquear(file, cta.id, { partyIdx: 0, slotIdx: 0, bloqueado: true }), CtaError);

  await asignar(file, cta.id, { partyIdx: 0, slotIdx: 0, userId: 'u1' });
  await bloquear(file, cta.id, { partyIdx: 0, slotIdx: 0, bloqueado: true });

  await assert.rejects(() => asignar(file, cta.id, { partyIdx: 0, slotIdx: 0, userId: 'u2' }), CtaError);
  await assert.rejects(() => asignar(file, cta.id, { partyIdx: 0, slotIdx: 0, userId: 'u1' }), CtaError);

  const { asignados } = await autorrellenar(file, cta.id);
  // 0:0 está bloqueado (no se toca); el otro hueco de maza-pesada (1:0) sigue libre y se cubre con u2.
  assert.deepEqual(asignados, [{ partyIdx: 1, slotIdx: 0, rolKey: 'maza-pesada', userId: 'u2' }]);

  const cargada = await ctaPorId(file, cta.id);
  assert.equal(cargada.asignaciones['0:0'].userId, 'u1'); // intacto, bloqueado
  assert.equal(cargada.asignaciones['1:0'].userId, 'u2');
});

test('autorrellenar: preferido gana sobre no-preferido a igualdad de todo lo demás', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-auto-pref' }));
  await inscribir(file, cta.id, { userId: 'u1', nombre: 'A', roles: ['santi'], preferido: 'santi' });
  await inscribir(file, cta.id, { userId: 'u2', nombre: 'B', roles: ['santi', 'hoj'], preferido: 'hoj' });

  const { asignados } = await autorrellenar(file, cta.id);
  const slotSanti = asignados.find((a) => a.rolKey === 'santi' && a.partyIdx === 0);
  assert.equal(slotSanti.userId, 'u1'); // u1 lo tiene como preferido, u2 no
});

test('autorrellenar: a igualdad de preferencia, gana mayor maestría en ese rol', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-auto-maestria' }));
  await inscribir(file, cta.id, { userId: 'u1', nombre: 'A', roles: ['santi'] });
  await inscribir(file, cta.id, { userId: 'u2', nombre: 'B', roles: ['santi'] });

  const maestriaFile = path.join(DIR, 'maestria-auto.json');
  await writeFile(
    maestriaFile,
    JSON.stringify({
      version: 1,
      jugadores: {
        u1: { nombre: 'A', roles: { santi: 2 }, ultimo: {} },
        u2: { nombre: 'B', roles: { santi: 5 }, ultimo: {} },
      },
      historialRoles: {},
    }),
    'utf8',
  );

  const { asignados } = await autorrellenar(file, cta.id, { maestriaFilePath: maestriaFile });
  const slotSanti = asignados.find((a) => a.rolKey === 'santi' && a.partyIdx === 0);
  assert.equal(slotSanti.userId, 'u2'); // 5 veces jugado > 2
});

test('autorrellenar: el preferido gana aunque el otro tenga más maestría', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-auto-pref-vs-maestria' }));
  await inscribir(file, cta.id, { userId: 'u1', nombre: 'A', roles: ['santi'], preferido: 'santi' });
  await inscribir(file, cta.id, { userId: 'u2', nombre: 'B', roles: ['santi', 'hoj'], preferido: 'hoj' });

  const maestriaFile = path.join(DIR, 'maestria-pref-vs-maestria.json');
  await writeFile(
    maestriaFile,
    JSON.stringify({
      version: 1,
      jugadores: {
        u1: { nombre: 'A', roles: { santi: 1 }, ultimo: {} },
        u2: { nombre: 'B', roles: { santi: 60 }, ultimo: {} }, // muchísima más maestría, pero no lo prefiere
      },
      historialRoles: {},
    }),
    'utf8',
  );

  const { asignados } = await autorrellenar(file, cta.id, { maestriaFilePath: maestriaFile });
  const slotSanti = asignados.find((a) => a.rolKey === 'santi' && a.partyIdx === 0);
  assert.equal(slotSanti.userId, 'u1'); // preferido siempre antes que maestría
});

test('autorrellenar: deja a los tentativos para el final, incluso por delante de un preferido no confirmado', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-auto-tentativo' }));
  // u1 se inscribió antes y tiene 'santi' como preferido, pero es tentativo.
  // u2 se inscribió después y no lo prefiere (su preferido es un rol que no
  // declara, así que cae al único que sí declaró: 'santi'), pero SÍ está
  // confirmado. Ninguno de los dos declara otro rol, para que no se lo
  // lleve antes un slot distinto ('hoj') y falsee el resultado.
  await inscribir(file, cta.id, { userId: 'u1', nombre: 'A', roles: ['santi'], preferido: 'santi', tentativo: true });
  await inscribir(file, cta.id, { userId: 'u2', nombre: 'B', roles: ['santi'], tentativo: false });

  const { asignados } = await autorrellenar(file, cta.id, {});
  const slotSanti = asignados.find((a) => a.rolKey === 'santi' && a.partyIdx === 0);
  assert.equal(slotSanti.userId, 'u2'); // confirmado gana al tentativo aunque este lo prefiera y el otro no
});

test('autorrellenar: entre dos tentativos, se siguen aplicando preferido/maestría/antigüedad con normalidad', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-auto-tentativo-empate' }));
  await inscribir(file, cta.id, { userId: 'u1', nombre: 'A', roles: ['santi'], preferido: 'santi', tentativo: true });
  await inscribir(file, cta.id, { userId: 'u2', nombre: 'B', roles: ['santi'], tentativo: true }); // preferido por defecto: santi (único rol)

  const { asignados } = await autorrellenar(file, cta.id, {});
  const slotSanti = asignados.find((a) => a.rolKey === 'santi' && a.partyIdx === 0);
  assert.equal(slotSanti.userId, 'u1'); // ambos tentativos y ambos prefieren santi -> gana quien se inscribió antes
});

test('autorrellenar: un jugador sin historial de maestría se autorrellena con normalidad', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-auto-sin-historial' }));
  await inscribir(file, cta.id, { userId: 'u1', nombre: 'A', roles: ['santi'], preferido: 'santi' });

  const maestriaFile = path.join(DIR, 'maestria-vacia.json');
  await writeFile(maestriaFile, JSON.stringify({ version: 1, jugadores: {}, historialRoles: {} }), 'utf8');

  const { asignados } = await autorrellenar(file, cta.id, { maestriaFilePath: maestriaFile });
  const slotSanti = asignados.find((a) => a.rolKey === 'santi' && a.partyIdx === 0);
  assert.equal(slotSanti.userId, 'u1');
});

test('autorrellenar: avisosRotacion avisa cuando el asignado repite un rol que cubrió los últimos 5 cierres', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-auto-rotacion' }));
  await inscribir(file, cta.id, { userId: 'u1', nombre: 'A', roles: ['santi'], preferido: 'santi' });

  const maestriaFile = path.join(DIR, 'maestria-rotacion.json');
  await writeFile(
    maestriaFile,
    JSON.stringify({
      version: 1,
      jugadores: { u1: { nombre: 'A', roles: { santi: 5 }, ultimo: {} } },
      historialRoles: { santi: ['u1', 'u1', 'u1', 'u1', 'u1'] },
    }),
    'utf8',
  );

  const { avisosRotacion } = await autorrellenar(file, cta.id, { maestriaFilePath: maestriaFile });
  assert.deepEqual(avisosRotacion, [{ rolKey: 'santi', userId: 'u1' }]);
});

test('autorrellenar: sin maestriaFilePath, avisosRotacion siempre está vacío', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-auto-sin-maestria-path' }));
  await inscribir(file, cta.id, { userId: 'u1', nombre: 'A', roles: ['santi'] });

  const { avisosRotacion } = await autorrellenar(file, cta.id);
  assert.deepEqual(avisosRotacion, []);
});

test('autorrellenar: empate total -> gana quien se inscribió antes', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-auto-ts' }));
  await inscribir(file, cta.id, { userId: 'u1', nombre: 'A', roles: ['santi'] });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await inscribir(file, cta.id, { userId: 'u2', nombre: 'B', roles: ['santi'] });

  const { asignados } = await autorrellenar(file, cta.id);
  const slotSanti = asignados.find((a) => a.rolKey === 'santi' && a.partyIdx === 0);
  assert.equal(slotSanti.userId, 'u1'); // se inscribió primero
});

test('autorrellenar: nunca mueve a alguien ya asignado, y los roles sin candidatos quedan en sinCubrir', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-auto-nomueve' }));
  await inscribir(file, cta.id, { userId: 'u1', nombre: 'A', roles: ['santi'] });
  await asignar(file, cta.id, { partyIdx: 1, slotIdx: 1, userId: 'u1' }); // santi en party2, no el preferido "mejor" slot

  const { asignados, sinCubrir } = await autorrellenar(file, cta.id);
  assert.equal(asignados.some((a) => a.userId === 'u1'), false); // ya asignado, no se toca ni se mueve

  // u1 es el único inscrito y ya está asignado (excluido del pool); el resto
  // de huecos (incluido el otro slot de santi) quedan sin cubrir.
  const rolesSinCubrir = sinCubrir.map((s) => s.rolKey).sort();
  assert.deepEqual(rolesSinCubrir, ['hoj', 'maza-pesada', 'maza-pesada', 'santi']);
});

test('slotsLibres, sinAsignar y rolesQueFaltan reflejan el estado tras asignar', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-consultas' }));
  await inscribir(file, cta.id, { userId: 'u1', nombre: 'A', roles: ['maza-pesada'] });
  await inscribir(file, cta.id, { userId: 'u2', nombre: 'B', roles: ['santi'] });
  await asignar(file, cta.id, { partyIdx: 0, slotIdx: 0, userId: 'u1' }); // maza-pesada

  const libres = await slotsLibres(file, cta.id);
  assert.equal(libres.length, 4); // 5 slots totales - 1 ocupado
  assert.equal(libres.some((l) => l.partyIdx === 0 && l.slotIdx === 0), false);

  const sinAsig = await sinAsignar(file, cta.id);
  assert.deepEqual(sinAsig.map((i) => i.userId), ['u2']);

  const faltan = await rolesQueFaltan(file, cta.id);
  const porRol = Object.fromEntries(faltan.map((f) => [f.rolKey, f.faltan]));
  // maza-pesada tiene 2 slots en total (0:0 y 1:0); solo se cubrió 0:0, queda 1 por cubrir.
  assert.deepEqual(porRol, { 'maza-pesada': 1, hoj: 1, santi: 2 });
});

test('cerrarCta quita la CTA de activas; sobre un id inexistente falla', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-cerrar' }));
  const cerrada = await cerrarCta(file, cta.id, { razon: 'manual' });
  assert.equal(cerrada.id, cta.id);
  assert.equal(cerrada.razonCierre, 'manual');

  assert.equal(await ctaDeCanal(file, 'chan-cerrar'), null);
  await assert.rejects(() => cerrarCta(file, cta.id), CtaError);
});

test('guardarCierrePendiente/pendienteDeVolcarDeCanal/quitarCierrePendiente: ciclo completo, indexado por canal', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-pendiente' }));
  const cerrada = await cerrarCta(file, cta.id, { razon: 'manual' });

  assert.equal(await pendienteDeVolcarDeCanal(file, 'chan-pendiente'), null);

  await guardarCierrePendiente(file, cerrada);
  const pendiente = await pendienteDeVolcarDeCanal(file, 'chan-pendiente');
  assert.equal(pendiente.id, cta.id);
  assert.equal(pendiente.razonCierre, 'manual');

  await quitarCierrePendiente(file, 'chan-pendiente');
  assert.equal(await pendienteDeVolcarDeCanal(file, 'chan-pendiente'), null);
});

test('quitarCierrePendiente sobre un canal sin nada pendiente no falla', async () => {
  const file = tempFile();
  await assert.doesNotReject(() => quitarCierrePendiente(file, 'chan-sin-pendiente'));
});

test('mutex global: varias inscripciones concurrentes sobre la misma CTA no se pisan', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-concurrencia' }));

  await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      inscribir(file, cta.id, { userId: `u${i}`, nombre: `User${i}`, roles: ['santi'] }),
    ),
  );

  const cargada = await ctaPorId(file, cta.id);
  assert.equal(cargada.inscritos.length, 5);
});

test('mutex global: dos oficiales asignando al MISMO slot a la vez — uno gana, el otro falla, y ninguna otra asignación concurrente se pierde', async () => {
  const file = tempFile();
  const cta = await crearCta(file, datosBase({ channelId: 'chan-concurrencia-slot', comp: compFixture() }));
  await Promise.all(
    ['u1', 'u2', 'u3'].map((userId) => inscribir(file, cta.id, { userId, nombre: userId, roles: ['santi'] })),
  );

  // u1 y u2 compiten por el MISMO slot (party 1, slot "santi" en índice 2);
  // a la vez, u3 asigna a un slot DISTINTO (party 1, "maza-pesada" en índice
  // 0) — esa tercera asignación no debe perderse ni verse afectada por la
  // pelea de las otras dos.
  const resultados = await Promise.allSettled([
    asignar(file, cta.id, { partyIdx: 0, slotIdx: 2, userId: 'u1' }),
    asignar(file, cta.id, { partyIdx: 0, slotIdx: 2, userId: 'u2' }),
    asignar(file, cta.id, { partyIdx: 0, slotIdx: 0, userId: 'u3' }),
  ]);

  const [rSlotPeleado1, rSlotPeleado2, rSlotAparte] = resultados;
  // De los dos que compiten por el mismo slot, exactamente uno gana.
  const ganadoresDelSlotPeleado = [rSlotPeleado1, rSlotPeleado2].filter((r) => r.status === 'fulfilled');
  const perdedoresDelSlotPeleado = [rSlotPeleado1, rSlotPeleado2].filter((r) => r.status === 'rejected');
  assert.equal(ganadoresDelSlotPeleado.length, 1);
  assert.equal(perdedoresDelSlotPeleado.length, 1);
  assert.ok(perdedoresDelSlotPeleado[0].reason instanceof CtaError);

  // La tercera asignación (slot distinto) tiene que haber ido bien igual.
  assert.equal(rSlotAparte.status, 'fulfilled');

  const cargada = await ctaPorId(file, cta.id);
  assert.equal(cargada.asignaciones['0:0'].userId, 'u3');
  assert.ok(['u1', 'u2'].includes(cargada.asignaciones['0:2'].userId));
  // El usuario nunca aparece en dos slots a la vez.
  const userIdsAsignados = Object.values(cargada.asignaciones).map((a) => a.userId);
  assert.equal(new Set(userIdsAsignados).size, userIdsAsignados.length);
});

test('migración: cta.json inexistente no necesita migrar', async () => {
  const file = tempFile();
  const { migrado } = await migrarCtaSiHaceFalta(file);
  assert.equal(migrado, false);
});

test('migración: formato ya nuevo (v2) no se toca', async () => {
  const file = tempFile();
  await crearCta(file, datosBase({ channelId: 'chan-yav2' }));
  const antes = JSON.stringify(await ctasActivas(file));

  const { migrado } = await migrarCtaSiHaceFalta(file);
  assert.equal(migrado, false);
  assert.equal(JSON.stringify(await ctasActivas(file)), antes);
});

test('un cta.json v2 de antes de "cerradasPendientes" no se migra ni se vacía (campo aditivo)', async () => {
  const file = tempFile();
  await writeFile(file, JSON.stringify({ version: 2, activas: { 'chan-sin-pendientes': { id: 'cta_vieja2' } } }), 'utf8');

  const { migrado } = await migrarCtaSiHaceFalta(file);
  assert.equal(migrado, false);

  assert.equal((await ctaDeCanal(file, 'chan-sin-pendientes')).id, 'cta_vieja2');
  assert.equal(await pendienteDeVolcarDeCanal(file, 'chan-sin-pendientes'), null);
});

test('migración: formato viejo (CTA "activa" en singular) se cierra, se reescribe vacío y queda backup', async () => {
  const file = tempFile();
  await writeFile(
    file,
    JSON.stringify({
      activa: { id: 'cta_vieja', nombre: 'CTA vieja', rol1: 'Tank', rol2: 'Healer', rol3: 'DPS', inscritos: [] },
    }),
    'utf8',
  );

  const { migrado } = await migrarCtaSiHaceFalta(file);
  assert.equal(migrado, true);

  const activas = await ctasActivas(file);
  assert.deepEqual(activas, []);

  const backupDir = path.join(DIR, 'backups');
  const entries = await readdir(backupDir);
  assert.ok(entries.some((name) => name.startsWith('cta-')), 'debe haber quedado un backup del formato viejo');
});
