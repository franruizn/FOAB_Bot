import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearSesion, obtenerSesion, actualizarSesion, limpiarSesion } from './ctaInscripcionSesion.js';

test('crearSesion + obtenerSesion: guarda y recupera los datos', () => {
  crearSesion('msg-1', { roles: ['hoj'], preferido: 'hoj', tentativo: false });
  const sesion = obtenerSesion('msg-1');
  assert.deepEqual(sesion.roles, ['hoj']);
  assert.equal(sesion.preferido, 'hoj');
  assert.equal(sesion.tentativo, false);
  limpiarSesion('msg-1');
});

test('obtenerSesion sobre una key inexistente devuelve null', () => {
  assert.equal(obtenerSesion('no-existe'), null);
});

test('actualizarSesion: hace merge sobre lo existente sin perder otros campos', () => {
  crearSesion('msg-2', { roles: ['hoj'], preferido: 'hoj', tentativo: false });
  actualizarSesion('msg-2', { roles: ['hoj', 'santi'] });
  const sesion = obtenerSesion('msg-2');
  assert.deepEqual(sesion.roles, ['hoj', 'santi']);
  assert.equal(sesion.preferido, 'hoj'); // no se tocó
  limpiarSesion('msg-2');
});

test('actualizarSesion sobre una key inexistente devuelve null y no crea nada', () => {
  assert.equal(actualizarSesion('no-existe', { roles: ['x'] }), null);
  assert.equal(obtenerSesion('no-existe'), null);
});

test('crearSesion sobre una key ya existente la reemplaza por completo', () => {
  crearSesion('msg-3', { roles: ['hoj'], preferido: 'hoj' });
  crearSesion('msg-3', { roles: ['santi'], preferido: 'santi' });
  assert.deepEqual(obtenerSesion('msg-3').roles, ['santi']);
  limpiarSesion('msg-3');
});

test('limpiarSesion borra la sesión y cancela su temporizador', () => {
  crearSesion('msg-4', { roles: [] });
  limpiarSesion('msg-4');
  assert.equal(obtenerSesion('msg-4'), null);
});

test('limpiarSesion sobre una key inexistente no lanza', () => {
  assert.doesNotThrow(() => limpiarSesion('no-existe'));
});
