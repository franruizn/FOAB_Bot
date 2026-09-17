import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generarNombreDeRolUnico, verificarPrerequisitosDeRol, crearRolDeCta, reconciliarRolDeCta, CtaRoleError } from './ctaRole.js';

function fakeGuild({ hasManageRoles = true, posicion = 5, existingRoleNames = [] } = {}) {
  const roles = existingRoleNames.map((name, i) => ({ id: `existing-${i}`, name }));
  return {
    members: {
      me: {
        permissions: { has: () => hasManageRoles },
        roles: { highest: { position: posicion } },
      },
    },
    roles: {
      cache: {
        get size() {
          return roles.length;
        },
        some: (fn) => roles.some(fn),
      },
      async create({ name, mentionable, hoist, reason }) {
        const role = { id: `role-${roles.length + 1}`, name, mentionable, hoist, reason };
        roles.push(role);
        return role;
      },
    },
  };
}

test('generarNombreDeRolUnico: "<nombre>_ddMM-HHmm" con la fecha dada', () => {
  const guild = fakeGuild();
  const fecha = new Date('2026-08-19T20:30:00');
  assert.equal(generarNombreDeRolUnico(guild, 'Hellgate', fecha), 'Hellgate_1908-2030');
});

test('generarNombreDeRolUnico: recorta el nombre si pasa de 100, nunca el sufijo', () => {
  const guild = fakeGuild();
  const fecha = new Date('2026-08-19T20:30:00');
  const nombreLargo = 'X'.repeat(150);

  const resultado = generarNombreDeRolUnico(guild, nombreLargo, fecha);
  assert.equal(resultado.length, 100);
  assert.ok(resultado.endsWith('_1908-2030'));
});

test('generarNombreDeRolUnico: si ya existe un rol con ese nombre exacto, añade "-2"', () => {
  const guild = fakeGuild({ existingRoleNames: ['Hellgate_1908-2030'] });
  const fecha = new Date('2026-08-19T20:30:00');
  assert.equal(generarNombreDeRolUnico(guild, 'Hellgate', fecha), 'Hellgate_1908-2030-2');
});

test('generarNombreDeRolUnico: con varias colisiones seguidas, sigue incrementando', () => {
  const guild = fakeGuild({ existingRoleNames: ['Hellgate_1908-2030', 'Hellgate_1908-2030-2', 'Hellgate_1908-2030-3'] });
  const fecha = new Date('2026-08-19T20:30:00');
  assert.equal(generarNombreDeRolUnico(guild, 'Hellgate', fecha), 'Hellgate_1908-2030-4');
});

test('generarNombreDeRolUnico: el sufijo incremental respeta el límite de 100 caracteres', () => {
  const guild = fakeGuild({ existingRoleNames: [`${'X'.repeat(100 - '_1908-2030'.length)}_1908-2030`] });
  const fecha = new Date('2026-08-19T20:30:00');
  const nombreLargo = 'X'.repeat(150);

  const resultado = generarNombreDeRolUnico(guild, nombreLargo, fecha);
  assert.ok(resultado.length <= 100);
  assert.ok(resultado.endsWith('_1908-2030-2'));
});

test('verificarPrerequisitosDeRol: falla sin permiso "Gestionar roles"', () => {
  const guild = fakeGuild({ hasManageRoles: false });
  assert.throws(() => verificarPrerequisitosDeRol(guild), CtaRoleError);
});

test('verificarPrerequisitosDeRol: falla si el rol del bot está en la posición 1 o más abajo', () => {
  assert.throws(() => verificarPrerequisitosDeRol(fakeGuild({ posicion: 1 })), CtaRoleError);
  assert.throws(() => verificarPrerequisitosDeRol(fakeGuild({ posicion: 0 })), CtaRoleError);
  assert.doesNotThrow(() => verificarPrerequisitosDeRol(fakeGuild({ posicion: 2 })));
});

test('verificarPrerequisitosDeRol: falla si el servidor ya está en el tope de 250 roles', () => {
  const guild = fakeGuild({ existingRoleNames: Array.from({ length: 250 }, (_, i) => `role-${i}`) });
  assert.throws(() => verificarPrerequisitosDeRol(guild), CtaRoleError);
});

test('verificarPrerequisitosDeRol: avisa a partir de 200 roles, sin bloquear', () => {
  const cerca = fakeGuild({ existingRoleNames: Array.from({ length: 200 }, (_, i) => `role-${i}`) });
  assert.ok(verificarPrerequisitosDeRol(cerca).avisoCapacidad);

  const lejos = fakeGuild({ existingRoleNames: Array.from({ length: 10 }, (_, i) => `role-${i}`) });
  assert.equal(verificarPrerequisitosDeRol(lejos).avisoCapacidad, null);
});

test('crearRolDeCta: rechaza "@everyone" y "@here" en el nombre de la CTA', async () => {
  const guild = fakeGuild();
  await assert.rejects(() => crearRolDeCta(guild, { nombreCta: '@everyone raid', fecha: new Date() }), CtaRoleError);
  await assert.rejects(() => crearRolDeCta(guild, { nombreCta: 'ping @here', fecha: new Date() }), CtaRoleError);
});

test('crearRolDeCta: crea el rol mentionable:true, hoist:false', async () => {
  const guild = fakeGuild();
  const { role, avisoCapacidad } = await crearRolDeCta(guild, { nombreCta: 'Hellgate', fecha: new Date('2026-08-19T20:30:00') });

  assert.equal(role.name, 'Hellgate_1908-2030');
  assert.equal(role.mentionable, true);
  assert.equal(role.hoist, false);
  assert.equal(avisoCapacidad, null);
});

test('crearRolDeCta: si fallan los prerequisitos, no crea ningún rol', async () => {
  const guild = fakeGuild({ hasManageRoles: false });
  await assert.rejects(() => crearRolDeCta(guild, { nombreCta: 'Hellgate', fecha: new Date() }), CtaRoleError);
  assert.equal(guild.roles.cache.size, 0);
});

// --- reconciliarRolDeCta: guild/miembro/rol en memoria, sin fetch de red ---

function fakeGuildReconciliacion({ roleId = 'role-1', idsConRolAhora = [], accionesQueFallan = [] } = {}) {
  const cache = new Map(); // members.cache
  const roleMembers = new Map(idsConRolAhora.map((id) => [id, { id }]));
  const llamadas = []; // { userId, accion: 'otorgar' | 'quitar' }
  let fetchBulkLlamado = false;

  function crearMember(userId) {
    return {
      id: userId,
      roles: {
        add: async () => {
          llamadas.push({ userId, accion: 'otorgar' });
          if (accionesQueFallan.includes(userId)) throw new Error(`boom-otorgar-${userId}`);
          roleMembers.set(userId, { id: userId });
        },
        remove: async () => {
          llamadas.push({ userId, accion: 'quitar' });
          if (accionesQueFallan.includes(userId)) throw new Error(`boom-quitar-${userId}`);
          roleMembers.delete(userId);
        },
      },
    };
  }

  return {
    llamadas,
    huboFetchBulk: () => fetchBulkLlamado,
    members: {
      cache,
      fetch: async (userId) => {
        if (userId === undefined) {
          fetchBulkLlamado = true;
          for (const id of roleMembers.keys()) {
            if (!cache.has(id)) cache.set(id, crearMember(id));
          }
          return cache;
        }
        if (!cache.has(userId)) cache.set(userId, crearMember(userId));
        return cache.get(userId);
      },
    },
    roles: { cache: new Map([[roleId, { id: roleId, members: roleMembers }]]) },
  };
}

function ctaConInscritos(userIds, { roleId = 'role-1' } = {}) {
  return { roleId, nombre: 'Hellgate', inscritos: userIds.map((userId) => ({ userId })) };
}

test('reconciliarRolDeCta: otorga el rol a quien está inscrito pero no lo tiene', async () => {
  const guild = fakeGuildReconciliacion({ idsConRolAhora: [] });
  const resultado = await reconciliarRolDeCta(guild, ctaConInscritos(['u1', 'u2']));

  assert.deepEqual(resultado, { otorgados: ['u1', 'u2'], quitados: [], fallos: [] });
  assert.deepEqual([...guild.roles.cache.get('role-1').members.keys()].sort(), ['u1', 'u2']);
});

test('reconciliarRolDeCta: quita el rol a quien lo tiene pero ya no está inscrito', async () => {
  const guild = fakeGuildReconciliacion({ idsConRolAhora: ['u1', 'u2'] });
  const resultado = await reconciliarRolDeCta(guild, ctaConInscritos(['u1']));

  assert.deepEqual(resultado, { otorgados: [], quitados: ['u2'], fallos: [] });
  assert.deepEqual([...guild.roles.cache.get('role-1').members.keys()], ['u1']);
});

test('reconciliarRolDeCta: si ya está al día, no toca a nadie', async () => {
  const guild = fakeGuildReconciliacion({ idsConRolAhora: ['u1'] });
  const resultado = await reconciliarRolDeCta(guild, ctaConInscritos(['u1']));

  assert.deepEqual(resultado, { otorgados: [], quitados: [], fallos: [] });
  assert.equal(guild.llamadas.length, 0);
});

test('reconciliarRolDeCta: sin roleId, no-op y no llama a members.fetch', async () => {
  const guild = fakeGuildReconciliacion({});
  const resultado = await reconciliarRolDeCta(guild, { roleId: null, nombre: 'Hellgate', inscritos: [{ userId: 'u1' }] });

  assert.deepEqual(resultado, { otorgados: [], quitados: [], fallos: [] });
  assert.equal(guild.huboFetchBulk(), false);
});

test('reconciliarRolDeCta: si el rol ya no existe en el servidor, no-op sin lanzar', async () => {
  const guild = fakeGuildReconciliacion({ roleId: 'role-1' });
  const resultado = await reconciliarRolDeCta(guild, ctaConInscritos(['u1'], { roleId: 'role-borrado' }));
  assert.deepEqual(resultado, { otorgados: [], quitados: [], fallos: [] });
});

test('reconciliarRolDeCta: un fallo al tocar el rol se recoge en fallos, sin abortar el resto', async () => {
  const guild = fakeGuildReconciliacion({ idsConRolAhora: [], accionesQueFallan: ['u1'] });
  const resultado = await reconciliarRolDeCta(guild, ctaConInscritos(['u1', 'u2']));

  assert.deepEqual(resultado.otorgados, ['u2']);
  assert.equal(resultado.fallos.length, 1);
  assert.equal(resultado.fallos[0].userId, 'u1');
  assert.equal(resultado.fallos[0].accion, 'otorgar');
});
