import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verificarPrerequisitosDeRol, RolePrerequisiteError } from './rolePrerequisites.js';

function fakeGuild({ hasManageRoles = true, posicion = 5, existingRoleNames = [] } = {}) {
  return {
    members: {
      me: {
        permissions: { has: () => hasManageRoles },
        roles: { highest: { position: posicion } },
      },
    },
    roles: {
      cache: {
        size: existingRoleNames.length,
      },
    },
  };
}

test('verificarPrerequisitosDeRol: falla sin permiso "Gestionar roles"', () => {
  const guild = fakeGuild({ hasManageRoles: false });
  assert.throws(() => verificarPrerequisitosDeRol(guild), RolePrerequisiteError);
});

test('verificarPrerequisitosDeRol: falla si el rol del bot está en la posición 1 o más abajo', () => {
  assert.throws(() => verificarPrerequisitosDeRol(fakeGuild({ posicion: 1 })), RolePrerequisiteError);
  assert.throws(() => verificarPrerequisitosDeRol(fakeGuild({ posicion: 0 })), RolePrerequisiteError);
  assert.doesNotThrow(() => verificarPrerequisitosDeRol(fakeGuild({ posicion: 2 })));
});

test('verificarPrerequisitosDeRol: falla si el servidor ya está en el tope de 250 roles', () => {
  const guild = fakeGuild({ existingRoleNames: Array.from({ length: 250 }, (_, i) => `role-${i}`) });
  assert.throws(() => verificarPrerequisitosDeRol(guild), RolePrerequisiteError);
});

test('verificarPrerequisitosDeRol: avisa a partir de 200 roles, sin bloquear', () => {
  const cerca = fakeGuild({ existingRoleNames: Array.from({ length: 200 }, (_, i) => `role-${i}`) });
  assert.ok(verificarPrerequisitosDeRol(cerca).avisoCapacidad);

  const lejos = fakeGuild({ existingRoleNames: Array.from({ length: 10 }, (_, i) => `role-${i}`) });
  assert.equal(verificarPrerequisitosDeRol(lejos).avisoCapacidad, null);
});
